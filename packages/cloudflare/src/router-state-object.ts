import {
  AccountBlock,
  AccountId,
  Candidate,
  LeaseToken,
  defaultRoutingConfig,
  selectAccount,
  type AccountId as AccountIdType,
  type RoutingConfig
} from "@akua-dev/codex-router-core"
import { Effect, Option, Schema } from "effect"

type SqlValue = ArrayBuffer | string | number | null
type SqlRow = Record<string, SqlValue>

interface SqlCursor {
  readonly toArray: () => Array<SqlRow>
}

interface RouterSqlStorage {
  readonly exec: (query: string, ...bindings: Array<SqlValue>) => SqlCursor
}

interface RouterObjectStorage {
  readonly sql: RouterSqlStorage
  readonly transactionSync: <A>(body: () => A) => A
}

interface RouterObjectState {
  readonly storage: RouterObjectStorage
  readonly blockConcurrencyWhile: <A>(body: () => Promise<A>) => Promise<A>
}

const AssignmentRow = Schema.Struct({
  session_key: Schema.String,
  account_id: Schema.String
})

const CountRow = Schema.Struct({
  account_id: Schema.String,
  count: Schema.Number
})

const HealthRow = Schema.Struct({
  account_id: Schema.String,
  block_kind: Schema.NullOr(Schema.Literals(["quota", "transient"])),
  retry_at: Schema.NullOr(Schema.Number),
  requires_reauth: Schema.Number
})

type HealthRow = typeof HealthRow.Type

const AcquirePayload = Schema.Struct({
  candidates: Schema.Array(Candidate),
  now: Schema.Number,
  sessionKey: Schema.optionalKey(Schema.String)
})

const RenewPayload = Schema.Struct({
  leaseToken: Schema.String,
  now: Schema.Number
})

const ReleasePayload = Schema.Struct({
  leaseToken: Schema.String
})

const RecordResponsePayload = Schema.Struct({
  accountId: Schema.String,
  kind: Schema.Literals([
    "success",
    "reauth",
    "quota",
    "forbidden",
    "not_found",
    "client_error",
    "transient"
  ]),
  now: Schema.Number,
  retryAt: Schema.NullOr(Schema.Number)
})

const SummaryPayload = Schema.Struct({
  now: Schema.Number
})

const CredentialPutPayload = Schema.Struct({
  accountId: Schema.String,
  keyVersion: Schema.String,
  nonce: Schema.String,
  ciphertext: Schema.String
})

const CredentialGetPayload = Schema.Struct({
  accountId: Schema.String
})

const migration = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS assignments (
    session_key TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reservations (
    lease_token TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    session_key TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS reservations_account_expiry
    ON reservations(account_id, expires_at);
  CREATE TABLE IF NOT EXISTS blocks (
    account_id TEXT PRIMARY KEY,
    block_kind TEXT CHECK(block_kind IN ('quota', 'transient') OR block_kind IS NULL),
    retry_at INTEGER,
    requires_reauth INTEGER NOT NULL DEFAULT 0 CHECK(requires_reauth IN (0, 1))
  );
  CREATE TABLE IF NOT EXISTS usage_snapshots (
    account_id TEXT PRIMARY KEY,
    observed_at INTEGER NOT NULL,
    payload_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS credentials (
    account_id TEXT PRIMARY KEY,
    key_version TEXT NOT NULL,
    nonce TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  INSERT OR IGNORE INTO schema_migrations(version, applied_at)
  VALUES (1, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
`

const decodeRows = <A>(schema: Schema.Decoder<A>, rows: Array<SqlRow>): ReadonlyArray<A> =>
  Schema.decodeUnknownSync(Schema.Array(schema))(rows)

const cleanup = (sql: RouterSqlStorage, now: number, config: RoutingConfig): void => {
  sql.exec("DELETE FROM reservations WHERE expires_at <= ?", now)
  sql.exec("DELETE FROM assignments WHERE updated_at + ? <= ?", config.assignmentTtlMs, now)
  sql.exec(
    `UPDATE blocks
       SET block_kind = NULL, retry_at = NULL
     WHERE retry_at IS NOT NULL AND retry_at <= ?`,
    now
  )
  sql.exec("DELETE FROM blocks WHERE block_kind IS NULL AND requires_reauth = 0")
}

const activeCounts = (sql: RouterSqlStorage): ReadonlyMap<AccountIdType, number> => {
  const rows = decodeRows(
    CountRow,
    sql.exec("SELECT account_id, COUNT(*) AS count FROM reservations GROUP BY account_id").toArray()
  )
  return new Map(rows.map((row) => [AccountId.make(row.account_id), row.count]))
}

const healthRows = (sql: RouterSqlStorage): ReadonlyMap<AccountIdType, HealthRow> => {
  const rows = decodeRows(
    HealthRow,
    sql.exec("SELECT account_id, block_kind, retry_at, requires_reauth FROM blocks").toArray()
  )
  return new Map(rows.map((row) => [AccountId.make(row.account_id), row]))
}

const blockFromRow = (row: HealthRow | undefined): AccountBlock | undefined => {
  if (row?.block_kind === null || row?.block_kind === undefined) {
    return undefined
  }
  return AccountBlock.make({
    kind: row.block_kind,
    ...(row.retry_at === null ? {} : { retryAt: row.retry_at })
  })
}

const overlayCandidate = (
  candidate: Candidate,
  counts: ReadonlyMap<AccountIdType, number>,
  health: ReadonlyMap<AccountIdType, HealthRow>
): Candidate => {
  const row = health.get(candidate.accountId)
  const block = blockFromRow(row) ?? candidate.block
  return Candidate.make({
    accountId: candidate.accountId,
    activeReservations: candidate.activeReservations + (counts.get(candidate.accountId) ?? 0),
    requiresReauthentication: candidate.requiresReauthentication || row?.requires_reauth === 1,
    ...(candidate.label === undefined ? {} : { label: candidate.label }),
    ...(candidate.usage === undefined ? {} : { usage: candidate.usage }),
    ...(block === undefined ? {} : { block })
  })
}

const currentAccount = (
  sql: RouterSqlStorage,
  sessionKey: string | undefined
): AccountIdType | undefined => {
  if (sessionKey === undefined) {
    return undefined
  }
  const rows = decodeRows(
    AssignmentRow,
    sql
      .exec("SELECT session_key, account_id FROM assignments WHERE session_key = ?", sessionKey)
      .toArray()
  )
  return rows[0] === undefined ? undefined : AccountId.make(rows[0].account_id)
}

const json = (value: unknown, init?: ResponseInit): Response => Response.json(value, init)

const decodeBody = async <A>(request: Request, schema: Schema.Decoder<A>): Promise<A> => {
  const body: unknown = await request.json()
  return Effect.runPromise(Schema.decodeUnknownEffect(schema)(body))
}

export class RouterStateObject {
  readonly #state: RouterObjectState
  readonly #config = defaultRoutingConfig
  readonly #ready: Promise<void>

  constructor(state: RouterObjectState, _environment: unknown) {
    this.#state = state
    this.#ready = state.blockConcurrencyWhile(async () => {
      state.storage.sql.exec(migration)
    })
  }

  async fetch(request: Request): Promise<Response> {
    await this.#ready
    const path = new URL(request.url).pathname
    try {
      if (path === "/acquire") {
        return await this.#acquire(request)
      }
      if (path === "/renew") {
        return await this.#renew(request)
      }
      if (path === "/release") {
        return await this.#release(request)
      }
      if (path === "/record-response") {
        return await this.#recordResponse(request)
      }
      if (path === "/summary") {
        return await this.#summary(request)
      }
      if (path === "/credential/put") {
        return await this.#putCredential(request)
      }
      if (path === "/credential/get") {
        return await this.#getCredential(request)
      }
      return json({ error: "not_found" }, { status: 404 })
    } catch {
      return json({ error: "invalid_state_request" }, { status: 400 })
    }
  }

  async #acquire(request: Request): Promise<Response> {
    const input = await decodeBody(request, AcquirePayload)
    return this.#state.storage.transactionSync(() => {
      const sql = this.#state.storage.sql
      cleanup(sql, input.now, this.#config)
      const counts = activeCounts(sql)
      const health = healthRows(sql)
      const candidates = input.candidates.map((candidate) =>
        overlayCandidate(candidate, counts, health)
      )
      const currentAccountId = currentAccount(sql, input.sessionKey)
      const decision = Effect.runSync(
        Effect.option(
          selectAccount({
            candidates,
            config: this.#config,
            now: input.now,
            ...(currentAccountId === undefined ? {} : { currentAccountId })
          })
        )
      )
      if (Option.isNone(decision)) {
        return json(null)
      }
      const leaseToken = LeaseToken.make(crypto.randomUUID())
      const expiresAt = input.now + this.#config.leaseTtlMs
      sql.exec(
        `INSERT INTO reservations(
           lease_token, account_id, session_key, created_at, expires_at
         ) VALUES (?, ?, ?, ?, ?)`,
        leaseToken,
        decision.value.accountId,
        input.sessionKey ?? null,
        input.now,
        expiresAt
      )
      if (input.sessionKey !== undefined) {
        sql.exec(
          `INSERT INTO assignments(session_key, account_id, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(session_key) DO UPDATE SET
             account_id = excluded.account_id,
             updated_at = excluded.updated_at`,
          input.sessionKey,
          decision.value.accountId,
          input.now
        )
      }
      return json({
        accountId: decision.value.accountId,
        expiresAt,
        leaseToken
      })
    })
  }

  async #renew(request: Request): Promise<Response> {
    const input = await decodeBody(request, RenewPayload)
    return this.#state.storage.transactionSync(() => {
      cleanup(this.#state.storage.sql, input.now, this.#config)
      const cursor = this.#state.storage.sql.exec(
        `UPDATE reservations
            SET expires_at = ?
          WHERE lease_token = ? AND expires_at > ?
          RETURNING lease_token`,
        input.now + this.#config.leaseTtlMs,
        input.leaseToken,
        input.now
      )
      return json({ renewed: cursor.toArray().length === 1 })
    })
  }

  async #release(request: Request): Promise<Response> {
    const input = await decodeBody(request, ReleasePayload)
    this.#state.storage.sql.exec("DELETE FROM reservations WHERE lease_token = ?", input.leaseToken)
    return json({ ok: true })
  }

  async #recordResponse(request: Request): Promise<Response> {
    const input = await decodeBody(request, RecordResponsePayload)
    this.#state.storage.transactionSync(() => {
      const sql = this.#state.storage.sql
      if (input.kind === "success") {
        sql.exec("DELETE FROM blocks WHERE account_id = ?", input.accountId)
      } else if (input.kind === "reauth") {
        sql.exec(
          `INSERT INTO blocks(account_id, block_kind, retry_at, requires_reauth)
           VALUES (?, NULL, NULL, 1)
           ON CONFLICT(account_id) DO UPDATE SET
             block_kind = NULL,
             retry_at = NULL,
             requires_reauth = 1`,
          input.accountId
        )
      } else if (input.kind === "quota" || input.kind === "transient") {
        const retryAt = input.retryAt ?? (input.kind === "transient" ? input.now + 30_000 : null)
        sql.exec(
          `INSERT INTO blocks(account_id, block_kind, retry_at, requires_reauth)
           VALUES (?, ?, ?, 0)
           ON CONFLICT(account_id) DO UPDATE SET
             block_kind = excluded.block_kind,
             retry_at = excluded.retry_at`,
          input.accountId,
          input.kind,
          retryAt
        )
      }
    })
    return json({ ok: true })
  }

  async #summary(request: Request): Promise<Response> {
    const input = await decodeBody(request, SummaryPayload)
    return this.#state.storage.transactionSync(() => {
      const sql = this.#state.storage.sql
      cleanup(sql, input.now, this.#config)
      const counts = activeCounts(sql)
      const health = healthRows(sql)
      const assignmentRows = decodeRows(
        CountRow,
        sql
          .exec("SELECT account_id, COUNT(*) AS count FROM assignments GROUP BY account_id")
          .toArray()
      )
      const accountIds = new Set<AccountIdType>([...counts.keys(), ...health.keys()])
      for (const row of assignmentRows) {
        accountIds.add(AccountId.make(row.account_id))
      }
      const assignments = decodeRows(
        Schema.Struct({ count: Schema.Number }),
        sql.exec("SELECT COUNT(*) AS count FROM assignments").toArray()
      )[0]?.count
      const reservations = decodeRows(
        Schema.Struct({ count: Schema.Number }),
        sql.exec("SELECT COUNT(*) AS count FROM reservations").toArray()
      )[0]?.count
      return json({
        accounts: [...accountIds]
          .sort((left, right) => left.localeCompare(right))
          .map((accountId) => {
            const row = health.get(accountId)
            return {
              accountId,
              activeReservations: counts.get(accountId) ?? 0,
              blockKind: row?.block_kind ?? null,
              requiresReauthentication: row?.requires_reauth === 1
            }
          }),
        activeReservations: reservations ?? 0,
        assignments: assignments ?? 0
      })
    })
  }

  async #putCredential(request: Request): Promise<Response> {
    const input = await decodeBody(request, CredentialPutPayload)
    this.#state.storage.sql.exec(
      `INSERT INTO credentials(
         account_id, key_version, nonce, ciphertext, updated_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET
         key_version = excluded.key_version,
         nonce = excluded.nonce,
         ciphertext = excluded.ciphertext,
         updated_at = excluded.updated_at`,
      input.accountId,
      input.keyVersion,
      input.nonce,
      input.ciphertext,
      Date.now()
    )
    return json({ ok: true })
  }

  async #getCredential(request: Request): Promise<Response> {
    const input = await decodeBody(request, CredentialGetPayload)
    const rows = this.#state.storage.sql
      .exec(
        `SELECT key_version AS keyVersion, nonce, ciphertext
           FROM credentials
          WHERE account_id = ?`,
        input.accountId
      )
      .toArray()
    const envelope = rows[0]
    return envelope === undefined
      ? json({ error: "credential_not_found" }, { status: 404 })
      : json(envelope)
  }
}
