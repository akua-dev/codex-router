import {
  OAuthInvalidGrantError,
  ProviderIdentityChangedError,
  SubscriptionCredential,
  UsageAuthenticationError,
  makeCodexUsageProbe,
  makeOpenAiOAuthClient
} from "@akua-dev/codex-router-codex"
import {
  AccountBlock,
  AccountId,
  Candidate,
  LeaseToken,
  UsageSnapshot,
  UsageWindow,
  defaultRoutingConfig,
  selectAccount,
  type AccountId as AccountIdType,
  type RoutingConfig
} from "@akua-dev/codex-router-core"
import { Effect, Option, Redacted, Result, Schema } from "effect"
import { decodeWorkerBindings, type WorkerRuntimeConfig } from "./config.ts"
import { makeCloudflareCodexControlTransport } from "./control-transport.ts"
import { decodeCredentialBundle, encodeCredentialBundle } from "./credential-bundle.ts"
import {
  EncryptedCredentialEnvelope,
  importCredentialKeyring,
  type CredentialCipherShape
} from "./credential-cipher.ts"

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

const AccountRow = Schema.Struct({
  account_id: Schema.String,
  ciphertext: Schema.String,
  credential_generation: Schema.Int.check(Schema.isGreaterThan(0)),
  enabled: Schema.Number,
  expires_at: Schema.Number,
  key_version: Schema.String,
  nonce: Schema.String,
  requires_reauth: Schema.Number
})
type AccountRow = typeof AccountRow.Type

const UsageRow = Schema.Struct({
  account_id: Schema.String,
  credential_generation: Schema.Int.check(Schema.isGreaterThan(0)),
  observed_at: Schema.Number,
  payload_json: Schema.String
})
type UsageRow = typeof UsageRow.Type

const AssignmentRow = Schema.Struct({
  account_id: Schema.String,
  session_key: Schema.String
})

const CountRow = Schema.Struct({
  account_id: Schema.String,
  count: Schema.Number
})

const HealthRow = Schema.Struct({
  account_id: Schema.String,
  block_kind: Schema.NullOr(Schema.Literals(["quota", "transient"])),
  requires_reauth: Schema.Number,
  retry_at: Schema.NullOr(Schema.Number)
})
type HealthRow = typeof HealthRow.Type

const RouteAcquirePayload = Schema.Struct({
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
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
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

const EnvelopePayload = Schema.Struct({
  ciphertext: Schema.String,
  keyVersion: Schema.String,
  nonce: Schema.String
})

const SeedPayload = Schema.Struct({
  accounts: Schema.Array(
    Schema.Struct({
      accountId: Schema.String,
      credential: EnvelopePayload,
      expiresAt: Schema.Number,
      generation: Schema.Int.check(Schema.isGreaterThan(0)),
      usage: UsageSnapshot
    })
  )
})
type SeedAccount = (typeof SeedPayload.Type)["accounts"][number]

const AdminCredentialPayload = Schema.Struct({
  accessToken: Schema.String.check(Schema.isNonEmpty()),
  accountId: Schema.String,
  expiresAt: Schema.Number,
  providerAccountId: Schema.String.check(Schema.isNonEmpty()),
  refreshToken: Schema.String.check(Schema.isNonEmpty())
})

const AdminEnabledPayload = Schema.Struct({
  accountId: Schema.String,
  enabled: Schema.Boolean,
  now: Schema.Number
})

const AdminAccountPayload = Schema.Struct({
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
  CREATE TABLE IF NOT EXISTS subscription_accounts (
    account_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
    credential_generation INTEGER NOT NULL CHECK(credential_generation > 0),
    expires_at INTEGER NOT NULL,
    requires_reauth INTEGER NOT NULL DEFAULT 0 CHECK(requires_reauth IN (0, 1)),
    key_version TEXT NOT NULL,
    nonce TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS subscription_usage (
    account_id TEXT PRIMARY KEY,
    credential_generation INTEGER NOT NULL CHECK(credential_generation > 0),
    observed_at INTEGER NOT NULL,
    payload_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS refresh_claims (
    account_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK(operation IN ('credential', 'usage')),
    credential_generation INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY(account_id, operation)
  );
  INSERT OR IGNORE INTO schema_migrations(version, applied_at)
  VALUES (2, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
`

const decodeRows = <A>(schema: Schema.Decoder<A>, rows: Array<SqlRow>): ReadonlyArray<A> =>
  Schema.decodeUnknownSync(Schema.Array(schema))(rows)

const json = (value: unknown, init?: ResponseInit): Response => Response.json(value, init)

const decodeBody = async <A>(request: Request, schema: Schema.Decoder<A>): Promise<A> => {
  const contentLength = request.headers.get("content-length")
  if (contentLength !== null && Number(contentLength) > 65_536) {
    throw new Error("request too large")
  }
  const body: unknown = await request.json()
  return Effect.runPromise(Schema.decodeUnknownEffect(schema)(body))
}

const cleanup = (sql: RouterSqlStorage, now: number, config: RoutingConfig): void => {
  sql.exec("DELETE FROM reservations WHERE expires_at <= ?", now)
  sql.exec("DELETE FROM assignments WHERE updated_at + ? <= ?", config.assignmentTtlMs, now)
  sql.exec("DELETE FROM refresh_claims WHERE expires_at <= ?", now)
  sql.exec(
    `UPDATE blocks
       SET block_kind = NULL, retry_at = NULL
     WHERE retry_at IS NOT NULL AND retry_at <= ?`,
    now
  )
  sql.exec("DELETE FROM blocks WHERE block_kind IS NULL AND requires_reauth = 0")
}

const accountRows = (sql: RouterSqlStorage): ReadonlyArray<AccountRow> =>
  decodeRows(
    AccountRow,
    sql
      .exec(
        `SELECT account_id, enabled, credential_generation, expires_at,
                requires_reauth, key_version, nonce, ciphertext
           FROM subscription_accounts
          ORDER BY account_id`
      )
      .toArray()
  )

const accountRow = (sql: RouterSqlStorage, accountId: AccountIdType): AccountRow | undefined =>
  decodeRows(
    AccountRow,
    sql
      .exec(
        `SELECT account_id, enabled, credential_generation, expires_at,
                requires_reauth, key_version, nonce, ciphertext
           FROM subscription_accounts
          WHERE account_id = ?`,
        accountId
      )
      .toArray()
  )[0]

const usageRows = (sql: RouterSqlStorage): ReadonlyMap<AccountIdType, UsageRow> =>
  new Map(
    decodeRows(
      UsageRow,
      sql
        .exec(
          `SELECT account_id, credential_generation, observed_at, payload_json
             FROM subscription_usage`
        )
        .toArray()
    ).map((row) => [AccountId.make(row.account_id), row])
  )

const activeCounts = (sql: RouterSqlStorage): ReadonlyMap<AccountIdType, number> =>
  new Map(
    decodeRows(
      CountRow,
      sql
        .exec("SELECT account_id, COUNT(*) AS count FROM reservations GROUP BY account_id")
        .toArray()
    ).map((row) => [AccountId.make(row.account_id), row.count])
  )

const healthRows = (sql: RouterSqlStorage): ReadonlyMap<AccountIdType, HealthRow> =>
  new Map(
    decodeRows(
      HealthRow,
      sql.exec("SELECT account_id, block_kind, retry_at, requires_reauth FROM blocks").toArray()
    ).map((row) => [AccountId.make(row.account_id), row])
  )

const currentAccount = (
  sql: RouterSqlStorage,
  sessionKey: string | undefined
): AccountIdType | undefined => {
  if (sessionKey === undefined) {
    return undefined
  }
  const row = decodeRows(
    AssignmentRow,
    sql
      .exec("SELECT session_key, account_id FROM assignments WHERE session_key = ?", sessionKey)
      .toArray()
  )[0]
  return row === undefined ? undefined : AccountId.make(row.account_id)
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

const decodeUsage = (row: UsageRow | undefined): UsageSnapshot | undefined => {
  if (row === undefined) {
    return undefined
  }
  try {
    return Schema.decodeUnknownSync(UsageSnapshot)(JSON.parse(row.payload_json))
  } catch {
    return undefined
  }
}

const envelopeFromRow = (row: AccountRow): EncryptedCredentialEnvelope =>
  EncryptedCredentialEnvelope.make({
    ciphertext: row.ciphertext,
    keyVersion: row.key_version,
    nonce: row.nonce
  })

const copyToArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const output = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(output).set(bytes)
  return output
}

const digest = (value: string): Promise<ArrayBuffer> =>
  crypto.subtle.digest("SHA-256", copyToArrayBuffer(new TextEncoder().encode(value)))

const constantTimeHashEqual = async (actual: string, expected: string): Promise<boolean> => {
  const [leftBuffer, rightBuffer] = await Promise.all([digest(actual), digest(expected)])
  const left = new Uint8Array(leftBuffer)
  const right = new Uint8Array(rightBuffer)
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return difference === 0
}

export class RouterStateObject {
  readonly #cipher: Promise<CredentialCipherShape>
  readonly #config = defaultRoutingConfig
  readonly #environment: Promise<WorkerRuntimeConfig>
  readonly #ready: Promise<void>
  readonly #state: RouterObjectState

  constructor(state: RouterObjectState, environment: unknown) {
    this.#state = state
    this.#environment = Effect.runPromise(decodeWorkerBindings(environment))
    this.#cipher = this.#environment.then((config) =>
      Effect.runPromise(importCredentialKeyring(config.credentialKeyring))
    )
    this.#ready = state.blockConcurrencyWhile(async () => {
      state.storage.sql.exec(migration)
      const [config, cipher] = await Promise.all([this.#environment, this.#cipher])
      const accounts = await Promise.all(
        config.accounts.map(async (account): Promise<SeedAccount> => {
          const credential = SubscriptionCredential.make({
            accessToken: account.accessToken,
            accountId: account.accountId,
            expiresAt: account.expiresAt,
            generation: 1,
            providerAccountId: account.providerAccountId,
            refreshToken: account.refreshToken
          })
          const encrypted = await Effect.runPromise(
            cipher.encrypt(
              account.accountId,
              credential.generation,
              encodeCredentialBundle(credential)
            )
          )
          return {
            accountId: account.accountId,
            credential: encrypted,
            expiresAt: credential.expiresAt,
            generation: credential.generation,
            usage: UsageSnapshot.make({
              accountId: account.accountId,
              observedAt: account.observedAt,
              short: UsageWindow.make({
                resetAt: account.shortResetAt,
                usedPercent: account.shortUsedPercent
              }),
              weekly: UsageWindow.make({
                resetAt: account.weeklyResetAt,
                usedPercent: account.weeklyUsedPercent
              })
            })
          }
        })
      )
      this.#insertSeedAccounts(accounts)
    })
  }

  async fetch(request: Request): Promise<Response> {
    await this.#ready
    const path = new URL(request.url).pathname
    try {
      if (path === "/seed" || path.startsWith("/admin/") || path === "/maintenance/sweep") {
        if (!(await this.#isInternalRequest(request))) {
          return json({ error: "unauthorized" }, { status: 401 })
        }
      }
      if (path === "/seed") {
        return await this.#seed(request)
      }
      if (path === "/route/acquire") {
        return await this.#routeAcquire(request)
      }
      if (path === "/route/renew" || path === "/renew") {
        return await this.#renew(request)
      }
      if (path === "/route/release" || path === "/release") {
        return await this.#release(request)
      }
      if (path === "/route/record-response") {
        return await this.#recordResponse(request)
      }
      if (path === "/summary") {
        return await this.#summary(request)
      }
      if (path === "/maintenance/sweep") {
        return await this.#maintenance(request)
      }
      if (path === "/admin/accounts/list") {
        return this.#adminList()
      }
      if (path === "/admin/accounts/credential") {
        return await this.#adminPutCredential(request)
      }
      if (path === "/admin/accounts/enabled") {
        return await this.#adminEnabled(request)
      }
      if (path === "/admin/accounts/remove") {
        return await this.#adminRemove(request)
      }
      if (path === "/admin/key-versions") {
        return this.#keyVersions()
      }
      return json({ error: "not_found" }, { status: 404 })
    } catch {
      return json({ error: "invalid_state_request" }, { status: 400 })
    }
  }

  async #isInternalRequest(request: Request): Promise<boolean> {
    const actual = request.headers.get("x-ai-router-internal-token")
    if (actual === null) {
      return false
    }
    const config = await this.#environment
    return constantTimeHashEqual(actual, Redacted.value(config.adminToken))
  }

  async #seed(request: Request): Promise<Response> {
    const input = await decodeBody(request, SeedPayload)
    return json({ inserted: this.#insertSeedAccounts(input.accounts) })
  }

  #insertSeedAccounts(accounts: ReadonlyArray<SeedAccount>): number {
    let inserted = 0
    this.#state.storage.transactionSync(() => {
      const sql = this.#state.storage.sql
      for (const account of accounts) {
        if (accountRow(sql, AccountId.make(account.accountId)) !== undefined) {
          continue
        }
        sql.exec(
          `INSERT INTO subscription_accounts(
             account_id, enabled, credential_generation, expires_at, requires_reauth,
             key_version, nonce, ciphertext, updated_at
           ) VALUES (?, 1, ?, ?, 0, ?, ?, ?, ?)`,
          account.accountId,
          account.generation,
          account.expiresAt,
          account.credential.keyVersion,
          account.credential.nonce,
          account.credential.ciphertext,
          Date.now()
        )
        sql.exec(
          `INSERT INTO subscription_usage(
             account_id, credential_generation, observed_at, payload_json
           ) VALUES (?, ?, ?, ?)`,
          account.accountId,
          account.generation,
          account.usage.observedAt,
          JSON.stringify(account.usage)
        )
        inserted += 1
      }
    })
    return inserted
  }

  #claim(
    accountId: AccountIdType,
    operation: "credential" | "usage",
    generation: number,
    now: number
  ): string | undefined {
    return this.#state.storage.transactionSync(() => {
      const sql = this.#state.storage.sql
      sql.exec(
        "DELETE FROM refresh_claims WHERE account_id = ? AND operation = ? AND expires_at <= ?",
        accountId,
        operation,
        now
      )
      const token = crypto.randomUUID()
      sql.exec(
        `INSERT OR IGNORE INTO refresh_claims(
           account_id, operation, credential_generation, token, expires_at
         ) VALUES (?, ?, ?, ?, ?)`,
        accountId,
        operation,
        generation,
        token,
        now + 30_000
      )
      const row = decodeRows(
        Schema.Struct({ token: Schema.String }),
        sql
          .exec(
            "SELECT token FROM refresh_claims WHERE account_id = ? AND operation = ?",
            accountId,
            operation
          )
          .toArray()
      )[0]
      return row?.token === token ? token : undefined
    })
  }

  #releaseClaim(token: string): void {
    this.#state.storage.sql.exec("DELETE FROM refresh_claims WHERE token = ?", token)
  }

  async #credentialFromRow(row: AccountRow): Promise<{
    readonly credential: SubscriptionCredential
    readonly envelope: EncryptedCredentialEnvelope
  }> {
    const cipher = await this.#cipher
    const accountId = AccountId.make(row.account_id)
    const decrypted = await Effect.runPromise(
      cipher.decryptForUse(accountId, row.credential_generation, envelopeFromRow(row))
    )
    if (decrypted.migration !== undefined) {
      this.#state.storage.sql.exec(
        `UPDATE subscription_accounts
            SET key_version = ?, nonce = ?, ciphertext = ?, updated_at = ?
          WHERE account_id = ? AND credential_generation = ?`,
        decrypted.migration.keyVersion,
        decrypted.migration.nonce,
        decrypted.migration.ciphertext,
        Date.now(),
        accountId,
        row.credential_generation
      )
    }
    const credential = await Effect.runPromise(
      decodeCredentialBundle(accountId, row.credential_generation, decrypted.plaintext)
    )
    return {
      credential,
      envelope: decrypted.migration ?? envelopeFromRow(row)
    }
  }

  async #ensureCredential(source: AccountRow, now: number): Promise<boolean> {
    if (
      source.enabled !== 1 ||
      source.requires_reauth === 1 ||
      source.expires_at > now + 5 * 60_000
    ) {
      return source.enabled === 1 && source.requires_reauth === 0
    }
    const accountId = AccountId.make(source.account_id)
    const claim = this.#claim(accountId, "credential", source.credential_generation, now)
    if (claim === undefined) {
      return false
    }
    try {
      const { credential } = await this.#credentialFromRow(source)
      const config = await this.#environment
      const transport = makeCloudflareCodexControlTransport(config)
      const oauth = makeOpenAiOAuthClient({ transport })
      const refreshed = await Effect.runPromise(Effect.result(oauth.refresh(credential)))
      if (Result.isFailure(refreshed)) {
        if (
          refreshed.failure instanceof OAuthInvalidGrantError ||
          refreshed.failure instanceof ProviderIdentityChangedError
        ) {
          this.#state.storage.sql.exec(
            `UPDATE subscription_accounts
                SET requires_reauth = 1
              WHERE account_id = ? AND credential_generation = ?`,
            accountId,
            source.credential_generation
          )
        }
        return false
      }
      const cipher = await this.#cipher
      const envelope = await Effect.runPromise(
        cipher.encrypt(
          accountId,
          refreshed.success.generation,
          encodeCredentialBundle(refreshed.success)
        )
      )
      return this.#state.storage.transactionSync(() => {
        const updated = this.#state.storage.sql
          .exec(
            `UPDATE subscription_accounts
                SET credential_generation = ?, expires_at = ?, requires_reauth = 0,
                    key_version = ?, nonce = ?, ciphertext = ?, updated_at = ?
              WHERE account_id = ? AND credential_generation = ?
                AND EXISTS(
                  SELECT 1 FROM refresh_claims
                   WHERE token = ? AND credential_generation = ?
                )
              RETURNING account_id`,
            refreshed.success.generation,
            refreshed.success.expiresAt,
            envelope.keyVersion,
            envelope.nonce,
            envelope.ciphertext,
            now,
            accountId,
            source.credential_generation,
            claim,
            source.credential_generation
          )
          .toArray().length
        this.#state.storage.sql.exec(
          "DELETE FROM subscription_usage WHERE account_id = ?",
          accountId
        )
        this.#releaseClaim(claim)
        return updated === 1
      })
    } finally {
      this.#releaseClaim(claim)
    }
  }

  async #ensureUsage(source: AccountRow, now: number): Promise<boolean> {
    const accountId = AccountId.make(source.account_id)
    const existing = usageRows(this.#state.storage.sql).get(accountId)
    if (
      existing !== undefined &&
      existing.credential_generation === source.credential_generation &&
      now - existing.observed_at < 60_000
    ) {
      return true
    }
    const claim = this.#claim(accountId, "usage", source.credential_generation, now)
    if (claim === undefined) {
      return (
        existing !== undefined &&
        existing.credential_generation === source.credential_generation &&
        now - existing.observed_at <= 24 * 60 * 60_000
      )
    }
    try {
      const { credential } = await this.#credentialFromRow(source)
      const config = await this.#environment
      const probe = makeCodexUsageProbe({
        transport: makeCloudflareCodexControlTransport(config)
      })
      const result = await Effect.runPromise(Effect.result(probe.getUsage(credential)))
      if (Result.isFailure(result)) {
        if (result.failure instanceof UsageAuthenticationError) {
          this.#state.storage.sql.exec(
            `UPDATE subscription_accounts
                SET requires_reauth = 1
              WHERE account_id = ? AND credential_generation = ?`,
            accountId,
            source.credential_generation
          )
        }
        return (
          existing !== undefined &&
          existing.credential_generation === source.credential_generation &&
          now - existing.observed_at <= 24 * 60 * 60_000
        )
      }
      return this.#state.storage.transactionSync(() => {
        const current = accountRow(this.#state.storage.sql, accountId)
        const claimStillHeld =
          decodeRows(
            Schema.Struct({ token: Schema.String }),
            this.#state.storage.sql
              .exec(
                "SELECT token FROM refresh_claims WHERE token = ? AND credential_generation = ?",
                claim,
                source.credential_generation
              )
              .toArray()
          )[0]?.token === claim
        if (current?.credential_generation !== source.credential_generation || !claimStillHeld) {
          return false
        }
        this.#state.storage.sql.exec(
          `INSERT INTO subscription_usage(
             account_id, credential_generation, observed_at, payload_json
           ) VALUES (?, ?, ?, ?)
           ON CONFLICT(account_id) DO UPDATE SET
             credential_generation = excluded.credential_generation,
             observed_at = excluded.observed_at,
             payload_json = excluded.payload_json`,
          accountId,
          source.credential_generation,
          result.success.observedAt,
          JSON.stringify(result.success)
        )
        this.#releaseClaim(claim)
        return true
      })
    } finally {
      this.#releaseClaim(claim)
    }
  }

  async #prepareAll(now: number): Promise<ReadonlyArray<AccountIdType>> {
    const ready: Array<AccountIdType> = []
    for (const source of accountRows(this.#state.storage.sql)) {
      if (!(await this.#ensureCredential(source, now))) {
        continue
      }
      const current = accountRow(this.#state.storage.sql, AccountId.make(source.account_id))
      if (
        current !== undefined &&
        current.enabled === 1 &&
        current.requires_reauth === 0 &&
        (await this.#ensureUsage(current, now))
      ) {
        ready.push(AccountId.make(source.account_id))
      }
    }
    return ready
  }

  async #routeAcquire(request: Request): Promise<Response> {
    const input = await decodeBody(request, RouteAcquirePayload)
    const ready = new Set(await this.#prepareAll(input.now))
    const selected = this.#state.storage.transactionSync(() => {
      const sql = this.#state.storage.sql
      cleanup(sql, input.now, this.#config)
      const counts = activeCounts(sql)
      const health = healthRows(sql)
      const usage = usageRows(sql)
      const candidates = accountRows(sql)
        .filter(
          (account) =>
            ready.has(AccountId.make(account.account_id)) &&
            account.enabled === 1 &&
            account.requires_reauth === 0
        )
        .map((account) => {
          const accountId = AccountId.make(account.account_id)
          const healthRow = health.get(accountId)
          const snapshot = decodeUsage(usage.get(accountId))
          const block = blockFromRow(healthRow)
          return Candidate.make({
            accountId,
            activeReservations: counts.get(accountId) ?? 0,
            requiresReauthentication:
              account.requires_reauth === 1 || healthRow?.requires_reauth === 1,
            ...(snapshot === undefined ? {} : { usage: snapshot }),
            ...(block === undefined ? {} : { block })
          })
        })
      const assigned = currentAccount(sql, input.sessionKey)
      const decision = Effect.runSync(
        Effect.option(
          selectAccount({
            candidates,
            config: this.#config,
            now: input.now,
            ...(assigned === undefined ? {} : { currentAccountId: assigned })
          })
        )
      )
      if (Option.isNone(decision)) {
        return undefined
      }
      const row = accountRow(sql, decision.value.accountId)
      if (row === undefined) {
        return undefined
      }
      const leaseToken = LeaseToken.make(crypto.randomUUID())
      const expiresAt = input.now + this.#config.leaseTtlMs
      sql.exec(
        `INSERT INTO reservations(
           lease_token, account_id, session_key, created_at, expires_at
         ) VALUES (?, ?, ?, ?, ?)`,
        leaseToken,
        row.account_id,
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
          row.account_id,
          input.now
        )
      }
      return { expiresAt, leaseToken, row }
    })
    if (selected === undefined) {
      return json(null)
    }
    try {
      const decrypted = await this.#credentialFromRow(selected.row)
      return json({
        accountId: selected.row.account_id,
        credential: {
          ciphertext: decrypted.envelope.ciphertext,
          generation: selected.row.credential_generation,
          keyVersion: decrypted.envelope.keyVersion,
          nonce: decrypted.envelope.nonce
        },
        expiresAt: selected.expiresAt,
        leaseToken: selected.leaseToken
      })
    } catch {
      this.#state.storage.sql.exec(
        "DELETE FROM reservations WHERE lease_token = ?",
        selected.leaseToken
      )
      return json(null)
    }
  }

  async #renew(request: Request): Promise<Response> {
    const input = await decodeBody(request, RenewPayload)
    return this.#state.storage.transactionSync(() => {
      cleanup(this.#state.storage.sql, input.now, this.#config)
      const rows = this.#state.storage.sql
        .exec(
          `UPDATE reservations
              SET expires_at = ?
            WHERE lease_token = ? AND expires_at > ?
            RETURNING lease_token`,
          input.now + this.#config.leaseTtlMs,
          input.leaseToken,
          input.now
        )
        .toArray()
      return json({ renewed: rows.length === 1 })
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
          `UPDATE subscription_accounts
              SET requires_reauth = 1
            WHERE account_id = ? AND credential_generation = ?`,
          input.accountId,
          input.generation
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
      const accounts = accountRows(sql)
      const assignments =
        decodeRows(
          Schema.Struct({ count: Schema.Number }),
          sql.exec("SELECT COUNT(*) AS count FROM assignments").toArray()
        )[0]?.count ?? 0
      const reservations =
        decodeRows(
          Schema.Struct({ count: Schema.Number }),
          sql.exec("SELECT COUNT(*) AS count FROM reservations").toArray()
        )[0]?.count ?? 0
      return json({
        accounts: accounts.map((account) => {
          const accountId = AccountId.make(account.account_id)
          const row = health.get(accountId)
          return {
            accountId,
            activeReservations: counts.get(accountId) ?? 0,
            blockKind: row?.block_kind ?? null,
            requiresReauthentication: account.requires_reauth === 1 || row?.requires_reauth === 1
          }
        }),
        activeReservations: reservations,
        assignments
      })
    })
  }

  async #maintenance(request: Request): Promise<Response> {
    const input = await decodeBody(request, SummaryPayload)
    const visited = accountRows(this.#state.storage.sql).length
    const ready = await this.#prepareAll(input.now)
    return json({ ready: ready.length, visited })
  }

  #adminList(): Response {
    const usage = usageRows(this.#state.storage.sql)
    return json({
      accounts: accountRows(this.#state.storage.sql).map((account) => ({
        accountId: account.account_id,
        enabled: account.enabled === 1,
        expiresAt: account.expires_at,
        generation: account.credential_generation,
        requiresReauthentication: account.requires_reauth === 1,
        ...(usage.get(AccountId.make(account.account_id)) === undefined
          ? {}
          : {
              usageObservedAt: usage.get(AccountId.make(account.account_id))?.observed_at
            })
      }))
    })
  }

  async #adminPutCredential(request: Request): Promise<Response> {
    const input = await decodeBody(request, AdminCredentialPayload)
    const accountId = AccountId.make(input.accountId)
    const existing = accountRow(this.#state.storage.sql, accountId)
    if (existing !== undefined) {
      const current = await this.#credentialFromRow(existing)
      if (Redacted.value(current.credential.providerAccountId) !== input.providerAccountId) {
        return json({ error: "provider_identity_conflict" }, { status: 409 })
      }
    }
    const generation = (existing?.credential_generation ?? 0) + 1
    const credential = SubscriptionCredential.make({
      accessToken: Redacted.make(input.accessToken),
      accountId,
      expiresAt: input.expiresAt,
      generation,
      providerAccountId: Redacted.make(input.providerAccountId),
      refreshToken: Redacted.make(input.refreshToken)
    })
    const cipher = await this.#cipher
    const envelope = await Effect.runPromise(
      cipher.encrypt(accountId, generation, encodeCredentialBundle(credential))
    )
    const written = this.#state.storage.transactionSync(() => {
      const current = accountRow(this.#state.storage.sql, accountId)
      if (
        existing !== undefined &&
        current?.credential_generation !== existing.credential_generation
      ) {
        return false
      }
      this.#state.storage.sql.exec(
        `INSERT INTO subscription_accounts(
           account_id, enabled, credential_generation, expires_at, requires_reauth,
           key_version, nonce, ciphertext, updated_at
         ) VALUES (?, 1, ?, ?, 0, ?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET
           credential_generation = excluded.credential_generation,
           expires_at = excluded.expires_at,
           requires_reauth = 0,
           key_version = excluded.key_version,
           nonce = excluded.nonce,
           ciphertext = excluded.ciphertext,
           updated_at = excluded.updated_at`,
        accountId,
        generation,
        credential.expiresAt,
        envelope.keyVersion,
        envelope.nonce,
        envelope.ciphertext,
        Date.now()
      )
      this.#state.storage.sql.exec("DELETE FROM subscription_usage WHERE account_id = ?", accountId)
      this.#state.storage.sql.exec("DELETE FROM refresh_claims WHERE account_id = ?", accountId)
      this.#state.storage.sql.exec("DELETE FROM blocks WHERE account_id = ?", accountId)
      return true
    })
    return written
      ? json({
          accountId,
          enabled: true,
          expiresAt: credential.expiresAt,
          generation,
          requiresReauthentication: false
        })
      : json({ error: "account_changed" }, { status: 409 })
  }

  async #adminEnabled(request: Request): Promise<Response> {
    const input = await decodeBody(request, AdminEnabledPayload)
    const rows = this.#state.storage.sql
      .exec(
        `UPDATE subscription_accounts
            SET enabled = ?, updated_at = ?
          WHERE account_id = ?
          RETURNING account_id`,
        input.enabled ? 1 : 0,
        input.now,
        input.accountId
      )
      .toArray()
    if (rows.length === 0) {
      return json({ error: "account_not_found" }, { status: 404 })
    }
    return this.#adminListFor(AccountId.make(input.accountId))
  }

  async #adminRemove(request: Request): Promise<Response> {
    const input = await decodeBody(request, AdminAccountPayload)
    const removed = this.#state.storage.transactionSync(() => {
      const exists =
        accountRow(this.#state.storage.sql, AccountId.make(input.accountId)) !== undefined
      for (const table of [
        "subscription_usage",
        "refresh_claims",
        "assignments",
        "reservations",
        "blocks",
        "subscription_accounts"
      ]) {
        this.#state.storage.sql.exec(`DELETE FROM ${table} WHERE account_id = ?`, input.accountId)
      }
      return exists
    })
    return removed
      ? new Response(null, { status: 204 })
      : json({ error: "account_not_found" }, { status: 404 })
  }

  #adminListFor(accountId: AccountIdType): Response {
    const row = accountRow(this.#state.storage.sql, accountId)
    if (row === undefined) {
      return json({ error: "account_not_found" }, { status: 404 })
    }
    const usage = usageRows(this.#state.storage.sql).get(accountId)
    return json({
      accountId,
      enabled: row.enabled === 1,
      expiresAt: row.expires_at,
      generation: row.credential_generation,
      requiresReauthentication: row.requires_reauth === 1,
      ...(usage === undefined ? {} : { usageObservedAt: usage.observed_at })
    })
  }

  #keyVersions(): Response {
    const versions = decodeRows(
      Schema.Struct({
        count: Schema.Number,
        keyVersion: Schema.String
      }),
      this.#state.storage.sql
        .exec(
          `SELECT key_version AS keyVersion, COUNT(*) AS count
             FROM subscription_accounts
            GROUP BY key_version
            ORDER BY key_version`
        )
        .toArray()
    )
    return json({ versions })
  }
}
