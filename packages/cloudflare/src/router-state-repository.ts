import {
  AccountId,
  LeaseToken,
  selectAccount,
  type AccountId as AccountIdType,
  Candidate,
  type RoutingConfig
} from "../../core/src/index.ts"
import { Context, Crypto, Effect, Layer, Option, Schema, Semaphore } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

export const RouterAccountRow = Schema.Struct({
  account_id: Schema.String,
  ciphertext: Schema.String,
  credential_generation: Schema.Int.check(Schema.isGreaterThan(0)),
  enabled: Schema.Number,
  expires_at: Schema.Number,
  key_version: Schema.String,
  nonce: Schema.String,
  requires_reauth: Schema.Number
})
export type RouterAccountRow = typeof RouterAccountRow.Type

export const RouterUsageRow = Schema.Struct({
  account_id: Schema.String,
  credential_generation: Schema.Int.check(Schema.isGreaterThan(0)),
  observed_at: Schema.Number,
  payload_json: Schema.String
})
export type RouterUsageRow = typeof RouterUsageRow.Type

export const RouterHealthRow = Schema.Struct({
  account_id: Schema.String,
  block_kind: Schema.NullOr(Schema.Literals(["quota", "transient"])),
  requires_reauth: Schema.Number,
  retry_at: Schema.NullOr(Schema.Number)
})
export type RouterHealthRow = typeof RouterHealthRow.Type

const AssignmentRow = Schema.Struct({
  account_id: Schema.String,
  session_key: Schema.String
})

const CountRow = Schema.Struct({
  account_id: Schema.String,
  count: Schema.Number
})

const TokenRow = Schema.Struct({
  token: Schema.String
})

const TotalRow = Schema.Struct({
  count: Schema.Number
})

const KeyVersionRow = Schema.Struct({
  count: Schema.Number,
  keyVersion: Schema.String
})

const decodeAccounts = Schema.decodeUnknownEffect(Schema.Array(RouterAccountRow))
const decodeUsage = Schema.decodeUnknownEffect(Schema.Array(RouterUsageRow))
const decodeHealth = Schema.decodeUnknownEffect(Schema.Array(RouterHealthRow))
const decodeAssignments = Schema.decodeUnknownEffect(Schema.Array(AssignmentRow))
const decodeCounts = Schema.decodeUnknownEffect(Schema.Array(CountRow))
const decodeTokens = Schema.decodeUnknownEffect(Schema.Array(TokenRow))
const decodeTotals = Schema.decodeUnknownEffect(Schema.Array(TotalRow))
const decodeKeyVersions = Schema.decodeUnknownEffect(Schema.Array(KeyVersionRow))

export class RouterStateRepositoryError extends Schema.TaggedErrorClass<RouterStateRepositoryError>()(
  "RouterStateRepositoryError",
  {
    message: Schema.String
  }
) {}

const repositoryFailure = () =>
  new RouterStateRepositoryError({
    message: "The Durable Object routing-state operation failed"
  })

const mapRepositoryFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError(repositoryFailure))

export interface SeedAccountRecord {
  readonly accountId: string
  readonly credential: {
    readonly ciphertext: string
    readonly keyVersion: string
    readonly nonce: string
  }
  readonly expiresAt: number
  readonly generation: number
  readonly usage: {
    readonly observedAt: number
  }
  readonly usageJson: string
}

export interface RefreshedCredentialCommit {
  readonly accountId: AccountIdType
  readonly ciphertext: string
  readonly expectedGeneration: number
  readonly expiresAt: number
  readonly keyVersion: string
  readonly newGeneration: number
  readonly nonce: string
  readonly now: number
  readonly token: string
}

export interface UsageCommit {
  readonly accountId: AccountIdType
  readonly expectedGeneration: number
  readonly observedAt: number
  readonly payloadJson: string
  readonly token: string
}

export interface SelectedRoute {
  readonly expiresAt: number
  readonly leaseToken: string
  readonly row: RouterAccountRow
}

export interface RoutingSummaryRecord {
  readonly accounts: ReadonlyArray<RouterAccountRow>
  readonly activeCounts: ReadonlyMap<AccountIdType, number>
  readonly assignments: number
  readonly health: ReadonlyMap<AccountIdType, RouterHealthRow>
  readonly reservations: number
}

export interface AdminCredentialWrite {
  readonly accountId: AccountIdType
  readonly ciphertext: string
  readonly expectedGeneration?: number
  readonly expiresAt: number
  readonly generation: number
  readonly keyVersion: string
  readonly nonce: string
  readonly now: number
}

export interface RouterStateRepositoryShape {
  readonly listAccounts: Effect.Effect<ReadonlyArray<RouterAccountRow>, RouterStateRepositoryError>
  readonly getAccount: (
    accountId: AccountIdType
  ) => Effect.Effect<Option.Option<RouterAccountRow>, RouterStateRepositoryError>
  readonly usageRows: Effect.Effect<
    ReadonlyMap<AccountIdType, RouterUsageRow>,
    RouterStateRepositoryError
  >
  readonly insertSeedAccounts: (
    accounts: ReadonlyArray<SeedAccountRecord>,
    now: number
  ) => Effect.Effect<number, RouterStateRepositoryError>
  readonly claim: (
    accountId: AccountIdType,
    operation: "credential" | "usage",
    generation: number,
    now: number
  ) => Effect.Effect<Option.Option<string>, RouterStateRepositoryError>
  readonly releaseClaim: (token: string) => Effect.Effect<void, RouterStateRepositoryError>
  readonly updateEnvelope: (
    accountId: AccountIdType,
    generation: number,
    keyVersion: string,
    nonce: string,
    ciphertext: string,
    now: number
  ) => Effect.Effect<void, RouterStateRepositoryError>
  readonly markRequiresReauthentication: (
    accountId: AccountIdType,
    generation: number
  ) => Effect.Effect<void, RouterStateRepositoryError>
  readonly commitRefreshedCredential: (
    commit: RefreshedCredentialCommit
  ) => Effect.Effect<boolean, RouterStateRepositoryError>
  readonly commitUsage: (commit: UsageCommit) => Effect.Effect<boolean, RouterStateRepositoryError>
  readonly acquire: (
    candidates: ReadonlyArray<Candidate>,
    ready: ReadonlySet<AccountIdType>,
    now: number,
    sessionKey: string | undefined,
    config: RoutingConfig
  ) => Effect.Effect<Option.Option<SelectedRoute>, RouterStateRepositoryError>
  readonly renew: (
    leaseToken: string,
    now: number,
    config: RoutingConfig
  ) => Effect.Effect<boolean, RouterStateRepositoryError>
  readonly release: (leaseToken: string) => Effect.Effect<void, RouterStateRepositoryError>
  readonly recordResponse: (input: {
    readonly accountId: string
    readonly generation: number
    readonly kind: "success" | "reauth" | "quota" | "transient" | "other"
    readonly now: number
    readonly retryAt: number | null
  }) => Effect.Effect<void, RouterStateRepositoryError>
  readonly summary: (
    now: number,
    config: RoutingConfig
  ) => Effect.Effect<RoutingSummaryRecord, RouterStateRepositoryError>
  readonly writeAdminCredential: (
    input: AdminCredentialWrite
  ) => Effect.Effect<boolean, RouterStateRepositoryError>
  readonly setEnabled: (
    accountId: AccountIdType,
    enabled: boolean,
    now: number
  ) => Effect.Effect<boolean, RouterStateRepositoryError>
  readonly removeAccount: (
    accountId: AccountIdType
  ) => Effect.Effect<boolean, RouterStateRepositoryError>
  readonly keyVersions: Effect.Effect<
    ReadonlyArray<typeof KeyVersionRow.Type>,
    RouterStateRepositoryError
  >
}

export class RouterStateRepository extends Context.Service<
  RouterStateRepository,
  RouterStateRepositoryShape
>()("@akua-dev/codex-router/RouterStateRepository") {}

export const makeRouterStateRepository = Effect.fn("makeRouterStateRepository")(function* () {
  const sql = yield* SqlClient.SqlClient
  const crypto = yield* Crypto.Crypto
  const transactionSemaphore = yield* Semaphore.make(1)
  const withTransaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    transactionSemaphore.withPermits(1)(sql.withTransaction(effect))

  const cleanup = Effect.fn("RouterStateRepository.cleanup")(function* (
    now: number,
    config: RoutingConfig
  ) {
    yield* sql`DELETE FROM reservations WHERE expires_at <= ${now}`
    yield* sql`
      DELETE FROM assignments
      WHERE updated_at + ${config.assignmentTtlMs} <= ${now}
    `
    yield* sql`DELETE FROM refresh_claims WHERE expires_at <= ${now}`
    yield* sql`
      UPDATE blocks
      SET block_kind = NULL, retry_at = NULL
      WHERE retry_at IS NOT NULL AND retry_at <= ${now}
    `
    yield* sql`DELETE FROM blocks WHERE block_kind IS NULL AND requires_reauth = 0`
  })

  const listAccounts = mapRepositoryFailure(
    sql<RouterAccountRow>`
      SELECT account_id, enabled, credential_generation, expires_at,
             requires_reauth, key_version, nonce, ciphertext
      FROM subscription_accounts
      ORDER BY account_id
    `.pipe(Effect.flatMap(decodeAccounts))
  )

  const getAccount = Effect.fn("RouterStateRepository.getAccount")((accountId: AccountIdType) =>
    mapRepositoryFailure(
      sql<RouterAccountRow>`
        SELECT account_id, enabled, credential_generation, expires_at,
               requires_reauth, key_version, nonce, ciphertext
        FROM subscription_accounts
        WHERE account_id = ${accountId}
      `.pipe(
        Effect.flatMap(decodeAccounts),
        Effect.map((rows) => Option.fromNullishOr(rows[0]))
      )
    )
  )

  const usageRows = mapRepositoryFailure(
    sql<RouterUsageRow>`
      SELECT account_id, credential_generation, observed_at, payload_json
      FROM subscription_usage
    `.pipe(
      Effect.flatMap(decodeUsage),
      Effect.map(
        (rows) => new Map(rows.map((row) => [AccountId.make(row.account_id), row] as const))
      )
    )
  )

  const activeCounts = mapRepositoryFailure(
    sql<typeof CountRow.Type>`
      SELECT account_id, COUNT(*) AS count
      FROM reservations
      GROUP BY account_id
    `.pipe(
      Effect.flatMap(decodeCounts),
      Effect.map(
        (rows) => new Map(rows.map((row) => [AccountId.make(row.account_id), row.count] as const))
      )
    )
  )

  const healthRows = mapRepositoryFailure(
    sql<RouterHealthRow>`
      SELECT account_id, block_kind, retry_at, requires_reauth
      FROM blocks
    `.pipe(
      Effect.flatMap(decodeHealth),
      Effect.map(
        (rows) => new Map(rows.map((row) => [AccountId.make(row.account_id), row] as const))
      )
    )
  )

  const currentAccount = Effect.fn("RouterStateRepository.currentAccount")(function* (
    sessionKey: string | undefined
  ) {
    if (sessionKey === undefined) {
      return Option.none<AccountIdType>()
    }
    const rows = yield* sql<typeof AssignmentRow.Type>`
      SELECT session_key, account_id
      FROM assignments
      WHERE session_key = ${sessionKey}
    `.pipe(Effect.flatMap(decodeAssignments))
    return Option.map(Option.fromNullishOr(rows[0]), (row) => AccountId.make(row.account_id))
  })

  const insertSeedAccounts: RouterStateRepositoryShape["insertSeedAccounts"] = (accounts, now) =>
    mapRepositoryFailure(
      withTransaction(
        Effect.gen(function* () {
          let inserted = 0
          for (const account of accounts) {
            const existing = yield* getAccount(AccountId.make(account.accountId))
            if (Option.isSome(existing)) {
              continue
            }
            yield* sql`
              INSERT INTO subscription_accounts(
                account_id, enabled, credential_generation, expires_at, requires_reauth,
                key_version, nonce, ciphertext, updated_at
              ) VALUES (
                ${account.accountId}, 1, ${account.generation}, ${account.expiresAt}, 0,
                ${account.credential.keyVersion}, ${account.credential.nonce},
                ${account.credential.ciphertext}, ${now}
              )
            `
            yield* sql`
              INSERT INTO subscription_usage(
                account_id, credential_generation, observed_at, payload_json
              ) VALUES (
                ${account.accountId}, ${account.generation}, ${account.usage.observedAt},
                ${account.usageJson}
              )
            `
            inserted += 1
          }
          return inserted
        })
      )
    )

  const claim: RouterStateRepositoryShape["claim"] = (accountId, operation, generation, now) =>
    mapRepositoryFailure(
      withTransaction(
        Effect.gen(function* () {
          yield* sql`
            DELETE FROM refresh_claims
            WHERE account_id = ${accountId}
              AND operation = ${operation}
              AND expires_at <= ${now}
          `
          const token = yield* crypto.randomUUIDv4
          yield* sql`
            INSERT OR IGNORE INTO refresh_claims(
              account_id, operation, credential_generation, token, expires_at
            ) VALUES (
              ${accountId}, ${operation}, ${generation}, ${token}, ${now + 30_000}
            )
          `
          const rows = yield* sql<typeof TokenRow.Type>`
            SELECT token
            FROM refresh_claims
            WHERE account_id = ${accountId} AND operation = ${operation}
          `.pipe(Effect.flatMap(decodeTokens))
          return rows[0]?.token === token ? Option.some(token) : Option.none<string>()
        })
      )
    )

  const releaseClaim: RouterStateRepositoryShape["releaseClaim"] = (token) =>
    mapRepositoryFailure(sql`DELETE FROM refresh_claims WHERE token = ${token}`).pipe(Effect.asVoid)

  const updateEnvelope: RouterStateRepositoryShape["updateEnvelope"] = (
    accountId,
    generation,
    keyVersion,
    nonce,
    ciphertext,
    now
  ) =>
    mapRepositoryFailure(
      sql`
        UPDATE subscription_accounts
        SET key_version = ${keyVersion}, nonce = ${nonce}, ciphertext = ${ciphertext},
            updated_at = ${now}
        WHERE account_id = ${accountId} AND credential_generation = ${generation}
      `
    ).pipe(Effect.asVoid)

  const markRequiresReauthentication: RouterStateRepositoryShape["markRequiresReauthentication"] = (
    accountId,
    generation
  ) =>
    mapRepositoryFailure(
      sql`
          UPDATE subscription_accounts
          SET requires_reauth = 1
          WHERE account_id = ${accountId} AND credential_generation = ${generation}
        `
    ).pipe(Effect.asVoid)

  const commitRefreshedCredential: RouterStateRepositoryShape["commitRefreshedCredential"] = (
    commit
  ) =>
    mapRepositoryFailure(
      withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly account_id: string }>`
            UPDATE subscription_accounts
            SET credential_generation = ${commit.newGeneration},
                expires_at = ${commit.expiresAt},
                requires_reauth = 0,
                key_version = ${commit.keyVersion},
                nonce = ${commit.nonce},
                ciphertext = ${commit.ciphertext},
                updated_at = ${commit.now}
            WHERE account_id = ${commit.accountId}
              AND credential_generation = ${commit.expectedGeneration}
              AND EXISTS(
                SELECT 1
                FROM refresh_claims
                WHERE token = ${commit.token}
                  AND credential_generation = ${commit.expectedGeneration}
              )
            RETURNING account_id
          `
          yield* sql`DELETE FROM subscription_usage WHERE account_id = ${commit.accountId}`
          yield* sql`DELETE FROM refresh_claims WHERE token = ${commit.token}`
          return rows.length === 1
        })
      )
    )

  const commitUsage: RouterStateRepositoryShape["commitUsage"] = (commit) =>
    mapRepositoryFailure(
      withTransaction(
        Effect.gen(function* () {
          const current = yield* getAccount(commit.accountId)
          const claims = yield* sql<typeof TokenRow.Type>`
            SELECT token
            FROM refresh_claims
            WHERE token = ${commit.token}
              AND credential_generation = ${commit.expectedGeneration}
          `.pipe(Effect.flatMap(decodeTokens))
          if (
            Option.isNone(current) ||
            current.value.credential_generation !== commit.expectedGeneration ||
            claims[0]?.token !== commit.token
          ) {
            return false
          }
          yield* sql`
            INSERT INTO subscription_usage(
              account_id, credential_generation, observed_at, payload_json
            ) VALUES (
              ${commit.accountId}, ${commit.expectedGeneration}, ${commit.observedAt},
              ${commit.payloadJson}
            )
            ON CONFLICT(account_id) DO UPDATE SET
              credential_generation = excluded.credential_generation,
              observed_at = excluded.observed_at,
              payload_json = excluded.payload_json
          `
          yield* sql`DELETE FROM refresh_claims WHERE token = ${commit.token}`
          return true
        })
      )
    )

  const acquire: RouterStateRepositoryShape["acquire"] = (
    candidates,
    ready,
    now,
    sessionKey,
    config
  ) =>
    mapRepositoryFailure(
      withTransaction(
        Effect.gen(function* () {
          yield* cleanup(now, config)
          // Durable Object SQLite exposes one transaction connection. Keep statements
          // sequential inside that transaction so child fibers never contend for the
          // client's single connection semaphore.
          const counts = yield* activeCounts
          const health = yield* healthRows
          const assigned = yield* currentAccount(sessionKey)
          const eligible = candidates
            .filter((candidate) => ready.has(candidate.accountId))
            .map((candidate) => {
              const row = health.get(candidate.accountId)
              return {
                ...candidate,
                activeReservations:
                  candidate.activeReservations + (counts.get(candidate.accountId) ?? 0),
                requiresReauthentication:
                  candidate.requiresReauthentication || row?.requires_reauth === 1,
                ...(row?.block_kind === null || row?.block_kind === undefined
                  ? {}
                  : {
                      block: {
                        kind: row.block_kind,
                        ...(row.retry_at === null ? {} : { retryAt: row.retry_at })
                      }
                    })
              } satisfies Candidate
            })
          const decision = yield* Effect.option(
            selectAccount({
              candidates: eligible,
              config,
              now,
              ...(Option.isNone(assigned) ? {} : { currentAccountId: assigned.value })
            })
          )
          if (Option.isNone(decision)) {
            return Option.none<SelectedRoute>()
          }
          const row = yield* getAccount(decision.value.accountId)
          if (Option.isNone(row)) {
            return Option.none<SelectedRoute>()
          }
          const leaseToken = LeaseToken.make(yield* crypto.randomUUIDv4)
          const expiresAt = now + config.leaseTtlMs
          yield* sql`
            INSERT INTO reservations(
              lease_token, account_id, session_key, created_at, expires_at
            ) VALUES (
              ${leaseToken}, ${row.value.account_id}, ${sessionKey ?? null}, ${now}, ${expiresAt}
            )
          `
          if (sessionKey !== undefined) {
            yield* sql`
              INSERT INTO assignments(session_key, account_id, updated_at)
              VALUES (${sessionKey}, ${row.value.account_id}, ${now})
              ON CONFLICT(session_key) DO UPDATE SET
                account_id = excluded.account_id,
                updated_at = excluded.updated_at
            `
          }
          return Option.some({
            expiresAt,
            leaseToken,
            row: row.value
          })
        })
      )
    )

  const renew: RouterStateRepositoryShape["renew"] = (leaseToken, now, config) =>
    mapRepositoryFailure(
      withTransaction(
        Effect.gen(function* () {
          yield* cleanup(now, config)
          const rows = yield* sql<{ readonly lease_token: string }>`
            UPDATE reservations
            SET expires_at = ${now + config.leaseTtlMs}
            WHERE lease_token = ${leaseToken} AND expires_at > ${now}
            RETURNING lease_token
          `
          return rows.length === 1
        })
      )
    )

  const release: RouterStateRepositoryShape["release"] = (leaseToken) =>
    mapRepositoryFailure(sql`DELETE FROM reservations WHERE lease_token = ${leaseToken}`).pipe(
      Effect.asVoid
    )

  const recordResponse: RouterStateRepositoryShape["recordResponse"] = (input) =>
    mapRepositoryFailure(
      withTransaction(
        input.kind === "success"
          ? sql`DELETE FROM blocks WHERE account_id = ${input.accountId}`.pipe(Effect.asVoid)
          : input.kind === "reauth"
            ? sql`
                UPDATE subscription_accounts
                SET requires_reauth = 1
                WHERE account_id = ${input.accountId}
                  AND credential_generation = ${input.generation}
              `.pipe(Effect.asVoid)
            : input.kind === "quota" || input.kind === "transient"
              ? sql`
                  INSERT INTO blocks(account_id, block_kind, retry_at, requires_reauth)
                  VALUES (
                    ${input.accountId},
                    ${input.kind},
                    ${input.retryAt ?? (input.kind === "transient" ? input.now + 30_000 : null)},
                    0
                  )
                  ON CONFLICT(account_id) DO UPDATE SET
                    block_kind = excluded.block_kind,
                    retry_at = excluded.retry_at
                `.pipe(Effect.asVoid)
              : Effect.void
      )
    ).pipe(Effect.asVoid)

  const summary: RouterStateRepositoryShape["summary"] = (now, config) =>
    mapRepositoryFailure(
      withTransaction(
        Effect.gen(function* () {
          yield* cleanup(now, config)
          const accounts = yield* listAccounts
          const counts = yield* activeCounts
          const health = yield* healthRows
          const assignmentRows = yield* sql<
            typeof TotalRow.Type
          >`SELECT COUNT(*) AS count FROM assignments`.pipe(Effect.flatMap(decodeTotals))
          const reservationRows = yield* sql<
            typeof TotalRow.Type
          >`SELECT COUNT(*) AS count FROM reservations`.pipe(Effect.flatMap(decodeTotals))
          return {
            accounts,
            activeCounts: counts,
            assignments: assignmentRows[0]?.count ?? 0,
            health,
            reservations: reservationRows[0]?.count ?? 0
          }
        })
      )
    )

  const writeAdminCredential: RouterStateRepositoryShape["writeAdminCredential"] = (input) =>
    mapRepositoryFailure(
      withTransaction(
        Effect.gen(function* () {
          const current = yield* getAccount(input.accountId)
          if (
            input.expectedGeneration !== undefined &&
            (Option.isNone(current) ||
              current.value.credential_generation !== input.expectedGeneration)
          ) {
            return false
          }
          yield* sql`
            INSERT INTO subscription_accounts(
              account_id, enabled, credential_generation, expires_at, requires_reauth,
              key_version, nonce, ciphertext, updated_at
            ) VALUES (
              ${input.accountId}, 1, ${input.generation}, ${input.expiresAt}, 0,
              ${input.keyVersion}, ${input.nonce}, ${input.ciphertext}, ${input.now}
            )
            ON CONFLICT(account_id) DO UPDATE SET
              credential_generation = excluded.credential_generation,
              expires_at = excluded.expires_at,
              requires_reauth = 0,
              key_version = excluded.key_version,
              nonce = excluded.nonce,
              ciphertext = excluded.ciphertext,
              updated_at = excluded.updated_at
          `
          yield* sql`DELETE FROM subscription_usage WHERE account_id = ${input.accountId}`
          yield* sql`DELETE FROM refresh_claims WHERE account_id = ${input.accountId}`
          yield* sql`DELETE FROM blocks WHERE account_id = ${input.accountId}`
          return true
        })
      )
    )

  const setEnabled: RouterStateRepositoryShape["setEnabled"] = (accountId, enabled, now) =>
    mapRepositoryFailure(
      sql<RouterAccountRow>`
        UPDATE subscription_accounts
        SET enabled = ${enabled ? 1 : 0}, updated_at = ${now}
        WHERE account_id = ${accountId}
        RETURNING account_id, enabled, credential_generation, expires_at,
                  requires_reauth, key_version, nonce, ciphertext
      `.pipe(
        Effect.flatMap(decodeAccounts),
        Effect.map((rows) => rows.length === 1)
      )
    )

  const removeAccount: RouterStateRepositoryShape["removeAccount"] = (accountId) =>
    mapRepositoryFailure(
      withTransaction(
        Effect.gen(function* () {
          const existing = yield* getAccount(accountId)
          yield* sql`DELETE FROM subscription_usage WHERE account_id = ${accountId}`
          yield* sql`DELETE FROM refresh_claims WHERE account_id = ${accountId}`
          yield* sql`DELETE FROM assignments WHERE account_id = ${accountId}`
          yield* sql`DELETE FROM reservations WHERE account_id = ${accountId}`
          yield* sql`DELETE FROM blocks WHERE account_id = ${accountId}`
          yield* sql`DELETE FROM subscription_accounts WHERE account_id = ${accountId}`
          return Option.isSome(existing)
        })
      )
    )

  const keyVersions = mapRepositoryFailure(
    sql<typeof KeyVersionRow.Type>`
      SELECT key_version AS keyVersion, COUNT(*) AS count
      FROM subscription_accounts
      GROUP BY key_version
      ORDER BY key_version
    `.pipe(Effect.flatMap(decodeKeyVersions))
  )

  return RouterStateRepository.of({
    acquire,
    claim,
    commitRefreshedCredential,
    commitUsage,
    getAccount,
    insertSeedAccounts,
    keyVersions,
    listAccounts,
    markRequiresReauthentication,
    recordResponse,
    release,
    releaseClaim,
    removeAccount,
    renew,
    setEnabled,
    summary,
    updateEnvelope,
    usageRows,
    writeAdminCredential
  })
})

export const routerStateRepositoryLayer = Layer.effect(
  RouterStateRepository,
  makeRouterStateRepository()
)
