import {
  AccountDirectory,
  AuthenticationError,
  ClientAuthenticator,
  CredentialUnavailableError,
  GatewayTelemetry,
  SubscriptionCredential,
  UpstreamTransport,
  configuredSubscriptionRouterLayer,
  type RouterFetch
} from "@akua-dev/codex-router-codex"
import { Candidate, UsageSnapshot, UsageWindow, type AccountId } from "@akua-dev/codex-router-core"
import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect"
import { makeAiGatewayTransport } from "./ai-gateway-transport.ts"
import type { WorkerConfiguredAccount, WorkerRuntimeConfig } from "./config.ts"
import { importAesGcmKeyFromBase64Url, makeCredentialCipher } from "./credential-cipher.ts"
import { makeDurableCredentialVault, type CredentialVault } from "./credential-vault.ts"
import { durableObjectRoutingStateLayer } from "./durable-object-routing-state.ts"
import { type CloudflareWorkerApplication, makeWorkerFetch } from "./worker.ts"

const CredentialBundle = Schema.Struct({
  accessToken: Schema.String,
  expiresAt: Schema.Number,
  providerAccountId: Schema.String,
  refreshToken: Schema.String
})

const decodeCredentialBundle = Schema.decodeUnknownEffect(Schema.fromJsonString(CredentialBundle))

const copyToArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

const digest = (value: string): Promise<ArrayBuffer> =>
  crypto.subtle.digest("SHA-256", copyToArrayBuffer(new TextEncoder().encode(value)))

const constantTimeHashEqual = async (actual: string, expected: string): Promise<boolean> => {
  const [actualHash, expectedHash] = await Promise.all([digest(actual), digest(expected)])
  const left = new Uint8Array(actualHash)
  const right = new Uint8Array(expectedHash)
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return difference === 0
}

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

const accountCandidate = (account: WorkerConfiguredAccount): Candidate =>
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

const encodedCredential = (account: WorkerConfiguredAccount): Redacted.Redacted<string> =>
  Redacted.make(
    JSON.stringify({
      accessToken: Redacted.value(account.accessToken),
      expiresAt: account.expiresAt,
      providerAccountId: Redacted.value(account.providerAccountId),
      refreshToken: Redacted.value(account.refreshToken)
    })
  )

const bootstrapVault = Effect.fn("bootstrapCredentialVault")(function* (
  accounts: ReadonlyArray<WorkerConfiguredAccount>,
  vault: CredentialVault
) {
  yield* Effect.forEach(
    accounts,
    (account) => vault.put(account.accountId, encodedCredential(account)),
    { concurrency: 1, discard: true }
  )
})

const credentialFromVault = Effect.fn("credentialFromVault")(function* (
  accountId: AccountId,
  vault: CredentialVault
) {
  const encoded = yield* vault.get(accountId).pipe(
    Effect.mapError(
      () =>
        new CredentialUnavailableError({
          message: "The selected encrypted credential is unavailable"
        })
    )
  )
  const bundle = yield* decodeCredentialBundle(Redacted.value(encoded)).pipe(
    Effect.mapError(
      () =>
        new CredentialUnavailableError({
          message: "The selected encrypted credential is invalid"
        })
    )
  )
  return SubscriptionCredential.make({
    accessToken: Redacted.make(bundle.accessToken),
    accountId,
    expiresAt: bundle.expiresAt,
    generation: 1,
    providerAccountId: Redacted.make(bundle.providerAccountId),
    refreshToken: Redacted.make(bundle.refreshToken)
  })
})

const workerAuthenticatorLayer = (config: WorkerRuntimeConfig) =>
  Layer.succeed(
    ClientAuthenticator,
    ClientAuthenticator.of({
      authenticate: (request) => {
        const actual = bearerToken(request)
        if (actual === undefined) {
          return Effect.succeed(false)
        }
        return Effect.tryPromise({
          try: () => constantTimeHashEqual(actual, Redacted.value(config.clientToken)),
          catch: () =>
            new AuthenticationError({
              message: "Client authentication could not be evaluated"
            })
        })
      }
    })
  )

const workerAccountDirectoryLayer = (config: WorkerRuntimeConfig, vault: CredentialVault) =>
  Layer.succeed(
    AccountDirectory,
    AccountDirectory.of({
      candidates: Effect.succeed(config.accounts.map(accountCandidate)),
      credential: (accountId) => credentialFromVault(accountId, vault)
    })
  )

const workerTelemetryLayer = Layer.succeed(
  GatewayTelemetry,
  GatewayTelemetry.of({
    decision: (event) =>
      Effect.logInfo("codex-router selected account").pipe(
        Effect.annotateLogs({
          accountId: event.accountId,
          reason: event.reason,
          runtime: "cloudflare"
        })
      ),
    bookkeepingFailure: (event) =>
      Effect.logWarning("codex-router bookkeeping failure").pipe(
        Effect.annotateLogs({
          accountId: event.accountId,
          operation: event.operation,
          runtime: "cloudflare"
        })
      )
  })
)

export const makeCloudflareWorkerApplication = async (
  config: WorkerRuntimeConfig,
  fetchImplementation: (request: Request) => Promise<Response> = fetch
): Promise<CloudflareWorkerApplication> => {
  const keys = await Effect.runPromise(
    Effect.forEach(
      config.credentialKeyring.keys,
      ([version, encoded]) =>
        importAesGcmKeyFromBase64Url(encoded).pipe(Effect.map((key) => [version, key] as const)),
      { concurrency: "unbounded" }
    ).pipe(Effect.map((entries) => new Map(entries)))
  )
  const cipher = makeCredentialCipher({
    currentVersion: config.credentialKeyring.currentVersion,
    keys
  })
  const objectId = config.routerState.idFromName("global")
  const stub = config.routerState.get(objectId)
  const vault = makeDurableCredentialVault(stub, cipher)
  await Effect.runPromise(bootstrapVault(config.accounts, vault))

  const dependencies = Layer.mergeAll(
    durableObjectRoutingStateLayer(stub),
    workerAuthenticatorLayer(config),
    workerAccountDirectoryLayer(config, vault),
    Layer.succeed(
      UpstreamTransport,
      makeAiGatewayTransport({
        accountId: config.aiGatewayAccountId,
        customProviderSlug: config.aiGatewayCustomProviderSlug,
        fetch: fetchImplementation,
        gatewayId: config.aiGatewayGatewayId,
        metadata: {
          protocol: "responses",
          runtime: "cloudflare"
        },
        runToken: config.aiGatewayRunToken
      })
    ),
    workerTelemetryLayer
  )
  const layer = Layer.merge(
    dependencies,
    configuredSubscriptionRouterLayer.pipe(Layer.provide(dependencies))
  )
  const runtime = ManagedRuntime.make(layer)
  try {
    const workerFetch: RouterFetch = await runtime.runPromise(makeWorkerFetch())
    return {
      close: runtime.dispose,
      fetch: workerFetch
    }
  } catch (error) {
    await runtime.dispose()
    throw error
  }
}
