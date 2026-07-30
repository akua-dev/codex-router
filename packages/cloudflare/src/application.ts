import {
  AccountAdmin,
  AdminAuthenticator,
  AuthenticationError,
  ClientAuthenticator,
  GatewayTelemetry,
  SubscriptionCredential,
  SubscriptionRouter,
  UpstreamTransport,
  type RouterFetch
} from "@akua-dev/codex-router-codex"
import { UsageSnapshot, UsageWindow } from "@akua-dev/codex-router-core"
import { Effect, Layer, ManagedRuntime, Redacted } from "effect"
import { makeAiGatewayTransport } from "./ai-gateway-transport.ts"
import type { WorkerConfiguredAccount, WorkerRuntimeConfig } from "./config.ts"
import { encodeCredentialBundle } from "./credential-bundle.ts"
import { importCredentialKeyring, type CredentialCipherShape } from "./credential-cipher.ts"
import { CredentialKeyAdmin, makeDurableCredentialKeyAdmin } from "./credential-key-admin.ts"
import { makeDurableAccountAdmin } from "./durable-account-admin.ts"
import { durableObjectRoutingStateLayer } from "./durable-object-routing-state.ts"
import { durableSubscriptionRouterLayer } from "./durable-subscription-router.ts"
import { type CloudflareWorkerApplication, makeWorkerFetch } from "./worker.ts"

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

const authenticate = (actual: string | undefined, expected: Redacted.Redacted<string>) => {
  if (actual === undefined) {
    return Effect.succeed(false)
  }
  return Effect.tryPromise({
    try: () => constantTimeHashEqual(actual, Redacted.value(expected)),
    catch: () =>
      new AuthenticationError({
        message: "Request authentication could not be evaluated"
      })
  })
}

const workerClientAuthenticatorLayer = (config: WorkerRuntimeConfig) =>
  Layer.succeed(
    ClientAuthenticator,
    ClientAuthenticator.of({
      authenticate: (request) => authenticate(bearerToken(request), config.clientToken)
    })
  )

const workerAdminAuthenticatorLayer = (config: WorkerRuntimeConfig) =>
  Layer.succeed(
    AdminAuthenticator,
    AdminAuthenticator.of({
      authenticate: (request) =>
        authenticate(request.headers.get("x-ai-router-admin-token")?.trim(), config.adminToken)
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

const configuredCredential = (account: WorkerConfiguredAccount): SubscriptionCredential =>
  SubscriptionCredential.make({
    accessToken: account.accessToken,
    accountId: account.accountId,
    expiresAt: account.expiresAt,
    generation: 1,
    providerAccountId: account.providerAccountId,
    refreshToken: account.refreshToken
  })

const configuredUsage = (account: WorkerConfiguredAccount): UsageSnapshot =>
  UsageSnapshot.make({
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

const seedIfAbsent = Effect.fn("Cloudflare.seedIfAbsent")(function* (
  config: WorkerRuntimeConfig,
  stub: ReturnType<WorkerRuntimeConfig["routerState"]["get"]>,
  cipher: CredentialCipherShape
) {
  if (config.accounts.length === 0) {
    return
  }
  const accounts = yield* Effect.forEach(
    config.accounts,
    (account) => {
      const credential = configuredCredential(account)
      return cipher
        .encrypt(account.accountId, credential.generation, encodeCredentialBundle(credential))
        .pipe(
          Effect.map((envelope) => ({
            accountId: account.accountId,
            credential: envelope,
            expiresAt: credential.expiresAt,
            generation: credential.generation,
            usage: configuredUsage(account)
          }))
        )
    },
    { concurrency: "unbounded" }
  )
  const response = yield* Effect.tryPromise({
    try: () =>
      stub.fetch(
        new Request("https://router-state.internal/seed", {
          body: JSON.stringify({ accounts }),
          headers: {
            "content-type": "application/json",
            "x-ai-router-internal-token": Redacted.value(config.adminToken)
          },
          method: "POST"
        })
      ),
    catch: () => new Error("Durable Object seed request failed")
  })
  if (!response.ok) {
    return yield* Effect.fail(new Error("Durable Object seed request failed"))
  }
})

export const makeCloudflareWorkerApplication = async (
  config: WorkerRuntimeConfig,
  fetchImplementation: (request: Request) => Promise<Response> = fetch
): Promise<CloudflareWorkerApplication> => {
  const cipher = await Effect.runPromise(importCredentialKeyring(config.credentialKeyring))
  const objectId = config.routerState.idFromName("global")
  const stub = config.routerState.get(objectId)
  await Effect.runPromise(seedIfAbsent(config, stub, cipher))
  const internalToken = Redacted.value(config.adminToken)

  const layer = Layer.mergeAll(
    durableObjectRoutingStateLayer(stub),
    durableSubscriptionRouterLayer(stub, cipher, internalToken),
    workerClientAuthenticatorLayer(config),
    workerAdminAuthenticatorLayer(config),
    Layer.succeed(AccountAdmin, makeDurableAccountAdmin(stub, internalToken)),
    Layer.succeed(CredentialKeyAdmin, makeDurableCredentialKeyAdmin(stub, internalToken)),
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
  const runtime = ManagedRuntime.make(layer)
  try {
    const workerFetch: RouterFetch = await runtime.runPromise(makeWorkerFetch())
    const router = await runtime.runPromise(SubscriptionRouter)
    return {
      close: runtime.dispose,
      fetch: workerFetch,
      maintain: (now: number) => Effect.runPromise(router.maintain(now))
    }
  } catch (error) {
    await runtime.dispose()
    throw error
  }
}
