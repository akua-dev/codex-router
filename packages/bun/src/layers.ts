import {
  AccountDirectory,
  ClientAuthenticator,
  CredentialUnavailableError,
  GatewayTelemetry,
  OAuthClient,
  SubscriptionAccountState,
  SubscriptionAccountStore,
  SubscriptionCredential,
  TransportError,
  UpstreamTransport,
  UsageProbe,
  makeCodexUsageProbe,
  makeFetchCodexControlTransport,
  makeOpenAiOAuthClient,
  subscriptionRouterLayer
} from "@akua-dev/codex-router-codex"
import {
  Candidate,
  UsageSnapshot,
  UsageWindow,
  defaultRoutingConfig,
  type AccountId
} from "@akua-dev/codex-router-core"
import { timingSafeEqual } from "node:crypto"
import { Effect, Layer, Redacted } from "effect"
import type { BunRuntimeConfig, ConfiguredAccount } from "./config.ts"
import { bunMaintenanceLayer } from "./maintenance.ts"
import { sqliteSubscriptionAccountStoreLayer } from "./sqlite-account-store.ts"

const bearerToken = (request: Request): string | undefined => {
  const dedicated = request.headers.get("x-ai-router-token")?.trim()
  if (dedicated !== undefined && dedicated.length > 0) {
    return dedicated
  }
  const authorization = request.headers.get("authorization")?.trim()
  if (authorization?.toLowerCase().startsWith("bearer ") === true) {
    return authorization.slice(7).trim()
  }
  return undefined
}

const constantTimeEqual = (actual: string, expected: string): boolean => {
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

export const bunClientAuthenticatorLayer = (config: BunRuntimeConfig) =>
  Layer.succeed(
    ClientAuthenticator,
    ClientAuthenticator.of({
      authenticate: (request) =>
        Effect.sync(() => {
          const actual = bearerToken(request)
          return (
            actual !== undefined && constantTimeEqual(actual, Redacted.value(config.clientToken))
          )
        })
    })
  )

const accountCandidate = (account: ConfiguredAccount): Candidate =>
  Candidate.make({
    accountId: account.accountId,
    activeReservations: 0,
    requiresReauthentication: false,
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
  })

const accountCredential = (account: ConfiguredAccount): SubscriptionCredential =>
  SubscriptionCredential.make({
    accessToken: account.accessToken,
    accountId: account.accountId,
    expiresAt: account.expiresAt,
    generation: 1,
    providerAccountId: account.providerAccountId,
    refreshToken: account.refreshToken
  })

const accountState = (account: ConfiguredAccount): SubscriptionAccountState => {
  const candidate = accountCandidate(account)
  return SubscriptionAccountState.make({
    accountId: account.accountId,
    credential: accountCredential(account),
    enabled: true,
    requiresReauthentication: false,
    ...(candidate.usage === undefined ? {} : { usage: candidate.usage })
  })
}

export const bunAccountDirectoryLayer = (config: BunRuntimeConfig) =>
  Layer.succeed(
    AccountDirectory,
    AccountDirectory.of({
      candidates: Effect.succeed(config.accounts.map(accountCandidate)),
      credential: (accountId: AccountId) => {
        const account = config.accounts.find((configured) => configured.accountId === accountId)
        return account === undefined
          ? Effect.fail(
              new CredentialUnavailableError({
                message: "No credential exists for the selected opaque account"
              })
            )
          : Effect.succeed(accountCredential(account))
      }
    })
  )

export const bunUpstreamTransportLayer = Layer.succeed(
  UpstreamTransport,
  UpstreamTransport.of({
    execute: (request) =>
      Effect.tryPromise({
        try: () => fetch(request),
        catch: () =>
          new TransportError({
            message: "The upstream request did not complete"
          })
      })
  })
)

export const bunGatewayTelemetryLayer = Layer.succeed(
  GatewayTelemetry,
  GatewayTelemetry.of({
    decision: (event) =>
      Effect.logInfo("codex-router selected account").pipe(
        Effect.annotateLogs({
          accountId: event.accountId,
          reason: event.reason,
          sessionBound: String(event.sessionKey.valueOrUndefined !== undefined)
        })
      ),
    bookkeepingFailure: (event) =>
      Effect.logWarning("codex-router bookkeeping failure").pipe(
        Effect.annotateLogs({
          accountId: event.accountId,
          operation: event.operation
        })
      )
  })
)

export const bunRuntimeLayer = (config: BunRuntimeConfig) => {
  const storage = sqliteSubscriptionAccountStoreLayer(config.databasePath, defaultRoutingConfig)
  const seed = Layer.effectDiscard(
    Effect.gen(function* () {
      const store = yield* SubscriptionAccountStore
      yield* store.seedIfAbsent(config.accounts.map(accountState))
    })
  ).pipe(Layer.provide(storage))
  const initializedStorage = Layer.merge(storage, seed)
  const controlTransport = makeFetchCodexControlTransport()
  const dependencies = Layer.mergeAll(
    initializedStorage,
    bunClientAuthenticatorLayer(config),
    bunUpstreamTransportLayer,
    bunGatewayTelemetryLayer,
    Layer.succeed(OAuthClient, makeOpenAiOAuthClient({ transport: controlTransport })),
    Layer.succeed(UsageProbe, makeCodexUsageProbe({ transport: controlTransport }))
  )
  const application = Layer.merge(
    dependencies,
    subscriptionRouterLayer.pipe(Layer.provide(dependencies))
  )
  return Layer.merge(application, bunMaintenanceLayer.pipe(Layer.provide(application)))
}
