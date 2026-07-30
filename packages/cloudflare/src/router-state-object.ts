import {
  OAuthInvalidGrantError,
  ProviderIdentityChangedError,
  SubscriptionCredential,
  UsageAuthenticationError,
  makeCodexUsageProbe,
  makeOpenAiOAuthClient,
  secureCompare
} from "@akua-dev/codex-router-codex"
import {
  AccountId,
  Candidate,
  UsageSnapshot,
  UsageWindow,
  defaultRoutingConfig,
  type AccountId as AccountIdType
} from "@akua-dev/codex-router-core"
import type { DurableObjectStorage } from "@cloudflare/workers-types"
import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto"
import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient"
import * as SqliteMigrator from "@effect/sql-sqlite-do/SqliteMigrator"
import {
  Clock,
  Crypto,
  Effect,
  Layer,
  ManagedRuntime,
  Option,
  Redacted,
  Result,
  Schema
} from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { decodeWorkerBindings, type WorkerRuntimeConfig } from "./config.ts"
import { makeCloudflareCodexControlTransport } from "./control-transport.ts"
import { decodeCredentialBundle, encodeCredentialBundle } from "./credential-bundle.ts"
import {
  EncryptedCredentialEnvelope,
  importCredentialKeyring,
  type CredentialCipherShape
} from "./credential-cipher.ts"
import { routerStateMigrations } from "./router-state-migrations.ts"
import {
  RouterStateRepository,
  routerStateRepositoryLayer,
  type RouterAccountRow,
  type RouterUsageRow,
  type SeedAccountRecord
} from "./router-state-repository.ts"

type SqlValue = ArrayBuffer | string | number | null

interface SqlCursor {
  readonly columnNames: ReadonlyArray<string>
  readonly raw: () => IterableIterator<Array<SqlValue>>
}

interface RouterSqlStorage {
  readonly exec: (query: string, ...bindings: Array<SqlValue>) => SqlCursor
}

interface RouterObjectStorage {
  readonly sql: RouterSqlStorage
  readonly transaction: <A>(
    body: (transaction: { readonly rollback: () => void }) => Promise<A>
  ) => Promise<A>
}

interface RouterObjectState {
  readonly storage: RouterObjectStorage
  readonly blockConcurrencyWhile: <A>(body: () => Promise<A>) => Promise<A>
}

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

export class RouterStateRequestError extends Schema.TaggedErrorClass<RouterStateRequestError>()(
  "RouterStateRequestError",
  {
    message: Schema.String
  }
) {}

const requestFailure = () =>
  new RouterStateRequestError({
    message: "The Durable Object request is invalid"
  })

const decodeBody = Effect.fn("RouterStateObject.decodeBody")(function* <A>(
  request: Request,
  schema: Schema.Decoder<A>
) {
  const contentLength = request.headers.get("content-length")
  if (
    contentLength !== null &&
    (!Number.isFinite(Number(contentLength)) || Number(contentLength) > 65_536)
  ) {
    return yield* requestFailure()
  }
  const body = yield* Effect.tryPromise({
    try: () => request.json(),
    catch: requestFailure
  })
  return yield* Schema.decodeUnknownEffect(schema)(body).pipe(Effect.mapError(requestFailure))
})

const json = (value: unknown, init?: ResponseInit): Response => Response.json(value, init)

const decodeUsage = (row: RouterUsageRow | undefined): UsageSnapshot | undefined => {
  if (row === undefined) {
    return undefined
  }
  return Schema.decodeUnknownOption(Schema.fromJsonString(UsageSnapshot))(row.payload_json)
    .valueOrUndefined
}

const envelopeFromRow = (row: RouterAccountRow): EncryptedCredentialEnvelope =>
  EncryptedCredentialEnvelope.make({
    ciphertext: row.ciphertext,
    keyVersion: row.key_version,
    nonce: row.nonce
  })

const accountSummary = (
  row: RouterAccountRow,
  usage: RouterUsageRow | undefined
): Readonly<Record<string, unknown>> => ({
  accountId: row.account_id,
  enabled: row.enabled === 1,
  expiresAt: row.expires_at,
  generation: row.credential_generation,
  requiresReauthentication: row.requires_reauth === 1,
  ...(usage === undefined ? {} : { usageObservedAt: usage.observed_at })
})

export class RouterStateObject {
  readonly #cipher: Promise<CredentialCipherShape>
  readonly #config = defaultRoutingConfig
  readonly #environment: Promise<WorkerRuntimeConfig>
  readonly #ready: Promise<void>
  readonly #runtime: ManagedRuntime.ManagedRuntime<
    Crypto.Crypto | HttpClient.HttpClient | RouterStateRepository,
    SqliteMigrator.MigrationError | SqlError
  >

  constructor(state: RouterObjectState, environment: unknown) {
    const sqlLayer = SqliteClient.layer({
      storage: state.storage as DurableObjectStorage,
      spanAttributes: {
        "db.namespace": "codex-router",
        "service.name": "codex-router-cloudflare-do"
      }
    })
    const migrations = SqliteMigrator.layer({
      loader: routerStateMigrations
    }).pipe(Layer.provide(sqlLayer))
    const platform = Layer.merge(BrowserCrypto.layer, FetchHttpClient.layer)
    const infrastructure = Layer.mergeAll(sqlLayer, migrations, platform)
    const repository = routerStateRepositoryLayer.pipe(Layer.provide(infrastructure))
    this.#runtime = ManagedRuntime.make(Layer.merge(repository, platform))
    this.#environment = this.#runtime.runPromise(decodeWorkerBindings(environment))
    this.#cipher = this.#environment.then((config) =>
      this.#runtime.runPromise(importCredentialKeyring(config.credentialKeyring))
    )
    this.#ready = state.blockConcurrencyWhile(() => this.#runtime.runPromise(this.#initialize()))
  }

  async fetch(request: Request): Promise<Response> {
    await this.#ready
    return this.#runtime.runPromise(
      this.#route(request).pipe(
        Effect.catchCause(() =>
          Effect.succeed(json({ error: "invalid_state_request" }, { status: 400 }))
        )
      )
    )
  }

  #initialize() {
    const environment = this.#environment
    const cipherPromise = this.#cipher
    return Effect.gen(function* () {
      const repository = yield* RouterStateRepository
      const [config, cipher] = yield* Effect.all([
        Effect.promise(() => environment),
        Effect.promise(() => cipherPromise)
      ])
      const accounts = yield* Effect.forEach(
        config.accounts,
        (account) =>
          Effect.gen(function* () {
            const credential = SubscriptionCredential.make({
              accessToken: account.accessToken,
              accountId: account.accountId,
              expiresAt: account.expiresAt,
              generation: 1,
              providerAccountId: account.providerAccountId,
              refreshToken: account.refreshToken
            })
            const encrypted = yield* cipher.encrypt(
              account.accountId,
              credential.generation,
              encodeCredentialBundle(credential)
            )
            const usage = UsageSnapshot.make({
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
            return {
              accountId: account.accountId,
              credential: encrypted,
              expiresAt: credential.expiresAt,
              generation: credential.generation,
              usage,
              usageJson: JSON.stringify(usage)
            } satisfies SeedAccountRecord
          }),
        { concurrency: "unbounded" }
      )
      const now = yield* Clock.currentTimeMillis
      yield* repository.insertSeedAccounts(accounts, now)
    })
  }

  #route(request: Request) {
    const isInternalRequest = this.#isInternalRequest.bind(this)
    const seed = this.#seed.bind(this)
    const routeAcquire = this.#routeAcquire.bind(this)
    const renew = this.#renew.bind(this)
    const release = this.#release.bind(this)
    const recordResponse = this.#recordResponse.bind(this)
    const summary = this.#summary.bind(this)
    const maintenance = this.#maintenance.bind(this)
    const adminList = this.#adminList.bind(this)
    const adminPutCredential = this.#adminPutCredential.bind(this)
    const adminEnabled = this.#adminEnabled.bind(this)
    const adminRemove = this.#adminRemove.bind(this)
    const keyVersions = this.#keyVersions.bind(this)
    return Effect.gen(function* () {
      const path = new URL(request.url).pathname
      if (path === "/seed" || path.startsWith("/admin/") || path === "/maintenance/sweep") {
        if (!(yield* isInternalRequest(request))) {
          return json({ error: "unauthorized" }, { status: 401 })
        }
      }
      if (path === "/seed") {
        return yield* seed(request)
      }
      if (path === "/route/acquire") {
        return yield* routeAcquire(request)
      }
      if (path === "/route/renew" || path === "/renew") {
        return yield* renew(request)
      }
      if (path === "/route/release" || path === "/release") {
        return yield* release(request)
      }
      if (path === "/route/record-response") {
        return yield* recordResponse(request)
      }
      if (path === "/summary") {
        return yield* summary(request)
      }
      if (path === "/maintenance/sweep") {
        return yield* maintenance(request)
      }
      if (path === "/admin/accounts/list") {
        return yield* adminList()
      }
      if (path === "/admin/accounts/credential") {
        return yield* adminPutCredential(request)
      }
      if (path === "/admin/accounts/enabled") {
        return yield* adminEnabled(request)
      }
      if (path === "/admin/accounts/remove") {
        return yield* adminRemove(request)
      }
      if (path === "/admin/key-versions") {
        return yield* keyVersions()
      }
      return json({ error: "not_found" }, { status: 404 })
    })
  }

  #isInternalRequest(request: Request) {
    const environment = this.#environment
    return Effect.gen(function* () {
      const actual = request.headers.get("x-ai-router-internal-token")
      if (actual === null) {
        return false
      }
      const config = yield* Effect.promise(() => environment)
      const result = yield* Effect.result(secureCompare(actual, Redacted.value(config.adminToken)))
      return Result.isSuccess(result) && result.success
    })
  }

  #seed(request: Request) {
    return Effect.gen(function* () {
      const input = yield* decodeBody(request, SeedPayload)
      const repository = yield* RouterStateRepository
      const now = yield* Clock.currentTimeMillis
      const accounts = input.accounts.map((account): SeedAccountRecord => ({
        ...account,
        usageJson: JSON.stringify(account.usage)
      }))
      const inserted = yield* repository.insertSeedAccounts(accounts, now)
      return json({ inserted })
    })
  }

  #credentialFromRow(row: RouterAccountRow) {
    const cipherPromise = this.#cipher
    return Effect.gen(function* () {
      const repository = yield* RouterStateRepository
      const cipher = yield* Effect.promise(() => cipherPromise)
      const accountId = AccountId.make(row.account_id)
      const decrypted = yield* cipher.decryptForUse(
        accountId,
        row.credential_generation,
        envelopeFromRow(row)
      )
      if (decrypted.migration !== undefined) {
        const now = yield* Clock.currentTimeMillis
        yield* repository.updateEnvelope(
          accountId,
          row.credential_generation,
          decrypted.migration.keyVersion,
          decrypted.migration.nonce,
          decrypted.migration.ciphertext,
          now
        )
      }
      const credential = yield* decodeCredentialBundle(
        accountId,
        row.credential_generation,
        decrypted.plaintext
      )
      return {
        credential,
        envelope: decrypted.migration ?? envelopeFromRow(row)
      }
    })
  }

  #ensureCredential(source: RouterAccountRow, now: number) {
    const credentialFromRow = this.#credentialFromRow.bind(this)
    const environment = this.#environment
    const cipherPromise = this.#cipher
    return Effect.gen(function* () {
      if (
        source.enabled !== 1 ||
        source.requires_reauth === 1 ||
        source.expires_at > now + 5 * 60_000
      ) {
        return source.enabled === 1 && source.requires_reauth === 0
      }
      const repository = yield* RouterStateRepository
      const accountId = AccountId.make(source.account_id)
      const claimed = yield* repository.claim(
        accountId,
        "credential",
        source.credential_generation,
        now
      )
      if (Option.isNone(claimed)) {
        return false
      }
      const claim = claimed.value
      return yield* Effect.gen(function* () {
        const { credential } = yield* credentialFromRow(source)
        const [config, client] = yield* Effect.all([
          Effect.promise(() => environment),
          HttpClient.HttpClient
        ])
        const oauth = makeOpenAiOAuthClient({
          transport: makeCloudflareCodexControlTransport(config, client)
        })
        const refreshed = yield* Effect.result(oauth.refresh(credential))
        if (Result.isFailure(refreshed)) {
          if (
            refreshed.failure instanceof OAuthInvalidGrantError ||
            refreshed.failure instanceof ProviderIdentityChangedError
          ) {
            yield* repository.markRequiresReauthentication(accountId, source.credential_generation)
          }
          return false
        }
        const cipher = yield* Effect.promise(() => cipherPromise)
        const envelope = yield* cipher.encrypt(
          accountId,
          refreshed.success.generation,
          encodeCredentialBundle(refreshed.success)
        )
        return yield* repository.commitRefreshedCredential({
          accountId,
          ciphertext: envelope.ciphertext,
          expectedGeneration: source.credential_generation,
          expiresAt: refreshed.success.expiresAt,
          keyVersion: envelope.keyVersion,
          newGeneration: refreshed.success.generation,
          nonce: envelope.nonce,
          now,
          token: claim
        })
      }).pipe(Effect.ensuring(repository.releaseClaim(claim).pipe(Effect.ignore)))
    })
  }

  #ensureUsage(source: RouterAccountRow, now: number) {
    const credentialFromRow = this.#credentialFromRow.bind(this)
    const environment = this.#environment
    return Effect.gen(function* () {
      const repository = yield* RouterStateRepository
      const accountId = AccountId.make(source.account_id)
      const usageRows = yield* repository.usageRows
      const existing = usageRows.get(accountId)
      if (
        existing !== undefined &&
        existing.credential_generation === source.credential_generation &&
        now - existing.observed_at < 60_000
      ) {
        return true
      }
      const claimed = yield* repository.claim(accountId, "usage", source.credential_generation, now)
      if (Option.isNone(claimed)) {
        return (
          existing !== undefined &&
          existing.credential_generation === source.credential_generation &&
          now - existing.observed_at <= 24 * 60 * 60_000
        )
      }
      const claim = claimed.value
      return yield* Effect.gen(function* () {
        const { credential } = yield* credentialFromRow(source)
        const [config, client] = yield* Effect.all([
          Effect.promise(() => environment),
          HttpClient.HttpClient
        ])
        const probe = makeCodexUsageProbe({
          transport: makeCloudflareCodexControlTransport(config, client)
        })
        const result = yield* Effect.result(probe.getUsage(credential))
        if (Result.isFailure(result)) {
          if (result.failure instanceof UsageAuthenticationError) {
            yield* repository.markRequiresReauthentication(accountId, source.credential_generation)
          }
          return (
            existing !== undefined &&
            existing.credential_generation === source.credential_generation &&
            now - existing.observed_at <= 24 * 60 * 60_000
          )
        }
        return yield* repository.commitUsage({
          accountId,
          expectedGeneration: source.credential_generation,
          observedAt: result.success.observedAt,
          payloadJson: JSON.stringify(result.success),
          token: claim
        })
      }).pipe(Effect.ensuring(repository.releaseClaim(claim).pipe(Effect.ignore)))
    })
  }

  #prepareAll(now: number) {
    const ensureCredential = this.#ensureCredential.bind(this)
    const ensureUsage = this.#ensureUsage.bind(this)
    return Effect.gen(function* () {
      const repository = yield* RouterStateRepository
      const ready: Array<AccountIdType> = []
      for (const source of yield* repository.listAccounts) {
        if (!(yield* ensureCredential(source, now))) {
          continue
        }
        const current = yield* repository.getAccount(AccountId.make(source.account_id))
        if (
          Option.isSome(current) &&
          current.value.enabled === 1 &&
          current.value.requires_reauth === 0 &&
          (yield* ensureUsage(current.value, now))
        ) {
          ready.push(AccountId.make(source.account_id))
        }
      }
      return ready
    })
  }

  #routeAcquire(request: Request) {
    const prepareAll = this.#prepareAll.bind(this)
    const credentialFromRow = this.#credentialFromRow.bind(this)
    const config = this.#config
    return Effect.gen(function* () {
      const input = yield* decodeBody(request, RouteAcquirePayload)
      const repository = yield* RouterStateRepository
      const ready = new Set(yield* prepareAll(input.now))
      const usage = yield* repository.usageRows
      const candidates = (yield* repository.listAccounts)
        .filter((account) => account.enabled === 1 && account.requires_reauth === 0)
        .map((account) => {
          const accountId = AccountId.make(account.account_id)
          const snapshot = decodeUsage(usage.get(accountId))
          return Candidate.make({
            accountId,
            activeReservations: 0,
            requiresReauthentication: false,
            ...(snapshot === undefined ? {} : { usage: snapshot })
          })
        })
      const selected = yield* repository.acquire(
        candidates,
        ready,
        input.now,
        input.sessionKey,
        config
      )
      if (Option.isNone(selected)) {
        return json(null)
      }
      const decrypted = yield* Effect.result(credentialFromRow(selected.value.row))
      if (Result.isFailure(decrypted)) {
        yield* repository.release(selected.value.leaseToken).pipe(Effect.ignore)
        return json(null)
      }
      return json({
        accountId: selected.value.row.account_id,
        credential: {
          ciphertext: decrypted.success.envelope.ciphertext,
          generation: selected.value.row.credential_generation,
          keyVersion: decrypted.success.envelope.keyVersion,
          nonce: decrypted.success.envelope.nonce
        },
        expiresAt: selected.value.expiresAt,
        leaseToken: selected.value.leaseToken
      })
    })
  }

  #renew(request: Request) {
    const config = this.#config
    return Effect.gen(function* () {
      const input = yield* decodeBody(request, RenewPayload)
      const repository = yield* RouterStateRepository
      const renewed = yield* repository.renew(input.leaseToken, input.now, config)
      return json({ renewed })
    })
  }

  #release(request: Request) {
    return Effect.gen(function* () {
      const input = yield* decodeBody(request, ReleasePayload)
      const repository = yield* RouterStateRepository
      yield* repository.release(input.leaseToken)
      return json({ ok: true })
    })
  }

  #recordResponse(request: Request) {
    return Effect.gen(function* () {
      const input = yield* decodeBody(request, RecordResponsePayload)
      const repository = yield* RouterStateRepository
      yield* repository.recordResponse({
        accountId: input.accountId,
        generation: input.generation,
        kind:
          input.kind === "success" ||
          input.kind === "reauth" ||
          input.kind === "quota" ||
          input.kind === "transient"
            ? input.kind
            : "other",
        now: input.now,
        retryAt: input.retryAt
      })
      return json({ ok: true })
    })
  }

  #summary(request: Request) {
    const config = this.#config
    return Effect.gen(function* () {
      const input = yield* decodeBody(request, SummaryPayload)
      const repository = yield* RouterStateRepository
      const summary = yield* repository.summary(input.now, config)
      return json({
        accounts: summary.accounts.map((account) => {
          const accountId = AccountId.make(account.account_id)
          const health = summary.health.get(accountId)
          return {
            accountId,
            activeReservations: summary.activeCounts.get(accountId) ?? 0,
            blockKind: health?.block_kind ?? null,
            requiresReauthentication: account.requires_reauth === 1 || health?.requires_reauth === 1
          }
        }),
        activeReservations: summary.reservations,
        assignments: summary.assignments
      })
    })
  }

  #maintenance(request: Request) {
    const prepareAll = this.#prepareAll.bind(this)
    return Effect.gen(function* () {
      const input = yield* decodeBody(request, SummaryPayload)
      const repository = yield* RouterStateRepository
      const visited = (yield* repository.listAccounts).length
      const ready = yield* prepareAll(input.now)
      return json({ ready: ready.length, visited })
    })
  }

  #adminList() {
    return Effect.gen(function* () {
      const repository = yield* RouterStateRepository
      const [accounts, usage] = yield* Effect.all([repository.listAccounts, repository.usageRows])
      return json({
        accounts: accounts.map((account) =>
          accountSummary(account, usage.get(AccountId.make(account.account_id)))
        )
      })
    })
  }

  #adminPutCredential(request: Request) {
    const credentialFromRow = this.#credentialFromRow.bind(this)
    const cipherPromise = this.#cipher
    return Effect.gen(function* () {
      const input = yield* decodeBody(request, AdminCredentialPayload)
      const repository = yield* RouterStateRepository
      const accountId = AccountId.make(input.accountId)
      const existing = yield* repository.getAccount(accountId)
      if (Option.isSome(existing)) {
        const current = yield* credentialFromRow(existing.value)
        if (Redacted.value(current.credential.providerAccountId) !== input.providerAccountId) {
          return json({ error: "provider_identity_conflict" }, { status: 409 })
        }
      }
      const generation = (Option.isSome(existing) ? existing.value.credential_generation : 0) + 1
      const credential = SubscriptionCredential.make({
        accessToken: Redacted.make(input.accessToken),
        accountId,
        expiresAt: input.expiresAt,
        generation,
        providerAccountId: Redacted.make(input.providerAccountId),
        refreshToken: Redacted.make(input.refreshToken)
      })
      const cipher = yield* Effect.promise(() => cipherPromise)
      const envelope = yield* cipher.encrypt(
        accountId,
        generation,
        encodeCredentialBundle(credential)
      )
      const now = yield* Clock.currentTimeMillis
      const written = yield* repository.writeAdminCredential({
        accountId,
        ciphertext: envelope.ciphertext,
        ...(Option.isNone(existing)
          ? {}
          : { expectedGeneration: existing.value.credential_generation }),
        expiresAt: credential.expiresAt,
        generation,
        keyVersion: envelope.keyVersion,
        nonce: envelope.nonce,
        now
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
    })
  }

  #adminEnabled(request: Request) {
    return Effect.gen(function* () {
      const input = yield* decodeBody(request, AdminEnabledPayload)
      const repository = yield* RouterStateRepository
      const accountId = AccountId.make(input.accountId)
      if (!(yield* repository.setEnabled(accountId, input.enabled, input.now))) {
        return json({ error: "account_not_found" }, { status: 404 })
      }
      const row = yield* repository.getAccount(accountId)
      if (Option.isNone(row)) {
        return json({ error: "account_not_found" }, { status: 404 })
      }
      const usage = yield* repository.usageRows
      return json(accountSummary(row.value, usage.get(accountId)))
    })
  }

  #adminRemove(request: Request) {
    return Effect.gen(function* () {
      const input = yield* decodeBody(request, AdminAccountPayload)
      const repository = yield* RouterStateRepository
      const removed = yield* repository.removeAccount(AccountId.make(input.accountId))
      return removed
        ? new Response(null, { status: 204 })
        : json({ error: "account_not_found" }, { status: 404 })
    })
  }

  #keyVersions() {
    return Effect.gen(function* () {
      const repository = yield* RouterStateRepository
      return json({ versions: yield* repository.keyVersions })
    })
  }
}
