import {
  AccountBlock,
  AccountId,
  AccountRoutingSummary,
  Candidate,
  LeaseToken,
  Reservation,
  RouteLease,
  RoutingState,
  RoutingStateError,
  RoutingSummary,
  SessionKey,
  defaultRoutingConfig,
  selectAccount,
  type AccountId as AccountIdType,
  type AcquireRouteInput,
  type LeaseToken as LeaseTokenType,
  type RoutingConfig,
  type RoutingStateShape,
  type SessionKey as SessionKeyType,
  type UpstreamResponseClassification
} from "@akua-dev/codex-router-core"
import { Database } from "bun:sqlite"
import { Effect, Layer, Option, Schema } from "effect"

const AssignmentRow = Schema.Struct({
  session_key: Schema.String,
  account_id: Schema.String,
  updated_at: Schema.Number
})

const ReservationRow = Schema.Struct({
  lease_token: Schema.String,
  account_id: Schema.String,
  session_key: Schema.NullOr(Schema.String),
  created_at: Schema.Number,
  expires_at: Schema.Number
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

const decodeAssignment = Schema.decodeUnknownSync(AssignmentRow)
const decodeReservation = Schema.decodeUnknownSync(ReservationRow)
const decodeCounts = Schema.decodeUnknownSync(Schema.Array(CountRow))
const decodeHealthRows = Schema.decodeUnknownSync(Schema.Array(HealthRow))

const migrations = `
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA foreign_keys = ON;

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

  INSERT OR IGNORE INTO schema_migrations(version, applied_at)
  VALUES (1, unixepoch() * 1000);
`

const routingError = (error: unknown) =>
  new RoutingStateError({
    message: error instanceof Error ? error.message : "SQLite routing state failed"
  })

const initialize = (database: Database): void => {
  database.exec(migrations)
}

const cleanup = (database: Database, now: number, config: RoutingConfig): void => {
  database.run("DELETE FROM reservations WHERE expires_at <= ?", [now])
  database.run("DELETE FROM assignments WHERE updated_at + ? <= ?", [config.assignmentTtlMs, now])
  database.run(
    `UPDATE blocks
       SET block_kind = NULL, retry_at = NULL
     WHERE retry_at IS NOT NULL AND retry_at <= ?`,
    [now]
  )
  database.run("DELETE FROM blocks WHERE block_kind IS NULL AND requires_reauth = 0")
}

const healthMap = (database: Database): ReadonlyMap<AccountIdType, HealthRow> => {
  const rows = decodeHealthRows(
    database
      .query<unknown, []>("SELECT account_id, block_kind, retry_at, requires_reauth FROM blocks")
      .all()
  )
  return new Map(rows.map((row) => [AccountId.make(row.account_id), row]))
}

const activeReservationCounts = (database: Database): ReadonlyMap<AccountIdType, number> => {
  const rows = decodeCounts(
    database
      .query<unknown, []>(
        "SELECT account_id, COUNT(*) AS count FROM reservations GROUP BY account_id"
      )
      .all()
  )
  return new Map(rows.map((row) => [AccountId.make(row.account_id), row.count]))
}

const rowBlock = (row: HealthRow | undefined): AccountBlock | undefined => {
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
  const block = rowBlock(row) ?? candidate.block
  return Candidate.make({
    accountId: candidate.accountId,
    activeReservations: candidate.activeReservations + (counts.get(candidate.accountId) ?? 0),
    requiresReauthentication: candidate.requiresReauthentication || row?.requires_reauth === 1,
    ...(candidate.label === undefined ? {} : { label: candidate.label }),
    ...(candidate.usage === undefined ? {} : { usage: candidate.usage }),
    ...(block === undefined ? {} : { block })
  })
}

const currentAssignment = (
  database: Database,
  sessionKey: SessionKeyType | undefined
): AccountIdType | undefined => {
  if (sessionKey === undefined) {
    return undefined
  }
  const raw = database
    .query<unknown, [string]>(
      "SELECT session_key, account_id, updated_at FROM assignments WHERE session_key = ?"
    )
    .get(sessionKey)
  if (raw === null || raw === undefined) {
    return undefined
  }
  return AccountId.make(decodeAssignment(raw).account_id)
}

const makeAcquire = (database: Database, config: RoutingConfig) => {
  const transaction = database.transaction((input: AcquireRouteInput) => {
    cleanup(database, input.now, config)
    const counts = activeReservationCounts(database)
    const health = healthMap(database)
    const candidates = input.candidates.map((candidate) =>
      overlayCandidate(candidate, counts, health)
    )
    const currentAccountId = currentAssignment(database, input.sessionKey)
    const decision = Effect.runSync(
      Effect.option(
        selectAccount({
          candidates,
          config,
          now: input.now,
          ...(currentAccountId === undefined ? {} : { currentAccountId })
        })
      )
    )
    if (Option.isNone(decision)) {
      return Option.none<RouteLease>()
    }

    const leaseToken = LeaseToken.make(crypto.randomUUID())
    const expiresAt = input.now + config.leaseTtlMs
    database.run(
      `INSERT INTO reservations(
         lease_token, account_id, session_key, created_at, expires_at
       ) VALUES (?, ?, ?, ?, ?)`,
      [leaseToken, decision.value.accountId, input.sessionKey ?? null, input.now, expiresAt]
    )
    if (input.sessionKey !== undefined) {
      database.run(
        `INSERT INTO assignments(session_key, account_id, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(session_key) DO UPDATE SET
           account_id = excluded.account_id,
           updated_at = excluded.updated_at`,
        [input.sessionKey, decision.value.accountId, input.now]
      )
    }

    return Option.some(
      RouteLease.make({
        accountId: decision.value.accountId,
        expiresAt,
        leaseToken,
        sessionKey:
          input.sessionKey === undefined
            ? Option.none<SessionKeyType>()
            : Option.some(input.sessionKey)
      })
    )
  })

  return (input: AcquireRouteInput) =>
    Effect.try({
      try: () => transaction.immediate(input),
      catch: routingError
    })
}

const makeRenew = (database: Database, config: RoutingConfig) => {
  const transaction = database.transaction((leaseToken: LeaseTokenType, now: number) => {
    cleanup(database, now, config)
    const result = database.run(
      "UPDATE reservations SET expires_at = ? WHERE lease_token = ? AND expires_at > ?",
      [now + config.leaseTtlMs, leaseToken, now]
    )
    return result.changes === 1
  })
  return (leaseToken: LeaseTokenType, now: number) =>
    Effect.try({
      try: () => transaction.immediate(leaseToken, now),
      catch: routingError
    })
}

const upsertHealth = (
  database: Database,
  accountId: AccountIdType,
  blockKind: "quota" | "transient" | null,
  retryAt: number | null,
  requiresReauthentication: boolean
): void => {
  database.run(
    `INSERT INTO blocks(account_id, block_kind, retry_at, requires_reauth)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET
       block_kind = excluded.block_kind,
       retry_at = excluded.retry_at,
       requires_reauth = MAX(blocks.requires_reauth, excluded.requires_reauth)`,
    [accountId, blockKind, retryAt, requiresReauthentication ? 1 : 0]
  )
}

const makeRecordResponse = (database: Database) => {
  const transaction = database.transaction(
    (accountId: AccountIdType, classification: UpstreamResponseClassification, now: number) => {
      if (classification.kind === "success") {
        database.run("DELETE FROM blocks WHERE account_id = ?", [accountId])
      } else if (classification.kind === "reauth") {
        upsertHealth(database, accountId, null, null, true)
      } else if (classification.kind === "quota") {
        upsertHealth(database, accountId, "quota", Option.getOrNull(classification.retryAt), false)
      } else if (classification.kind === "transient") {
        upsertHealth(
          database,
          accountId,
          "transient",
          Option.getOrElse(classification.retryAt, () => now + 30_000),
          false
        )
      }
    }
  )
  return (accountId: AccountIdType, classification: UpstreamResponseClassification, now: number) =>
    Effect.try({
      try: () => transaction.immediate(accountId, classification, now),
      catch: routingError
    })
}

const makeSummary = (database: Database, config: RoutingConfig) => (now: number) =>
  Effect.try({
    try: () => {
      cleanup(database, now, config)
      const counts = activeReservationCounts(database)
      const health = healthMap(database)
      const assignmentAccountRows = decodeCounts(
        database
          .query<unknown, []>(
            "SELECT account_id, COUNT(*) AS count FROM assignments GROUP BY account_id"
          )
          .all()
      )
      const accountIds = new Set<AccountIdType>([...counts.keys(), ...health.keys()])
      for (const row of assignmentAccountRows) {
        accountIds.add(AccountId.make(row.account_id))
      }
      const accounts = [...accountIds]
        .sort((left, right) => left.localeCompare(right))
        .map((accountId) => {
          const row = health.get(accountId)
          return AccountRoutingSummary.make({
            accountId,
            activeReservations: counts.get(accountId) ?? 0,
            blockKind:
              row?.block_kind === null || row?.block_kind === undefined
                ? Option.none()
                : Option.some(row.block_kind),
            requiresReauthentication: row?.requires_reauth === 1
          })
        })
      const assignmentCount = database
        .query<unknown, []>("SELECT COUNT(*) AS count FROM assignments")
        .get()
      const reservationCount = database
        .query<unknown, []>("SELECT COUNT(*) AS count FROM reservations")
        .get()
      const assignments = Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Number }))(
        assignmentCount
      ).count
      const activeReservations = Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Number }))(
        reservationCount
      ).count
      return RoutingSummary.make({
        accounts,
        activeReservations,
        assignments
      })
    },
    catch: routingError
  })

export interface SqliteRoutingStateHandle {
  readonly state: RoutingStateShape
  readonly close: Effect.Effect<void>
}

export const openSqliteRoutingState = Effect.fn("openSqliteRoutingState")(function* (
  databasePath: string,
  config: RoutingConfig = defaultRoutingConfig
) {
  const database = yield* Effect.try({
    try: () => {
      const opened = new Database(databasePath, { create: true, strict: true })
      initialize(opened)
      return opened
    },
    catch: routingError
  })

  const state = RoutingState.of({
    acquire: makeAcquire(database, config),
    recordResponse: makeRecordResponse(database),
    release: (leaseToken) =>
      Effect.try({
        try: () => {
          database.run("DELETE FROM reservations WHERE lease_token = ?", [leaseToken])
        },
        catch: routingError
      }),
    renew: makeRenew(database, config),
    summary: makeSummary(database, config)
  })

  return {
    close: Effect.sync(() => database.close()),
    state
  } satisfies SqliteRoutingStateHandle
})

export const sqliteRoutingStateLayer = (
  databasePath: string,
  config: RoutingConfig = defaultRoutingConfig
) =>
  Layer.effect(
    RoutingState,
    Effect.acquireRelease(
      openSqliteRoutingState(databasePath, config),
      (handle) => handle.close
    ).pipe(Effect.map((handle) => handle.state))
  )

export const decodeReservationRow = (input: unknown): Reservation => {
  const row = decodeReservation(input)
  return Reservation.make({
    accountId: AccountId.make(row.account_id),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    leaseToken: LeaseToken.make(row.lease_token),
    sessionKey:
      row.session_key === null
        ? Option.none<SessionKeyType>()
        : Option.some(SessionKey.make(row.session_key))
  })
}
