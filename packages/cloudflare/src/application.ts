import {
  AccountAdmin,
  AdminAuthenticator,
  AuthenticationError,
  ClientAuthenticator,
  GatewayTelemetry,
  SubscriptionRouter,
  UpstreamTransport,
  secureCompare,
  type RouterFetch
} from "@akua-dev/codex-router-codex"
import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto"
import { Crypto, Effect, Layer, ManagedRuntime, Redacted } from "effect"
import { makeAiGatewayTransport } from "./ai-gateway-transport.ts"
import type { WorkerRuntimeConfig } from "./config.ts"
import { importCredentialKeyring } from "./credential-cipher.ts"
import { CredentialKeyAdmin, makeDurableCredentialKeyAdmin } from "./credential-key-admin.ts"
import { makeDurableAccountAdmin } from "./durable-account-admin.ts"
import { durableObjectRoutingStateLayer } from "./durable-object-routing-state.ts"
import { durableSubscriptionRouterLayer } from "./durable-subscription-router.ts"
import { type CloudflareWorkerApplication, makeWorkerFetch } from "./worker.ts"

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

const authenticate = (
  crypto: Crypto.Crypto,
  actual: string | undefined,
  expected: Redacted.Redacted<string>
) => {
  if (actual === undefined) {
    return Effect.succeed(false)
  }
  return secureCompare(actual, Redacted.value(expected)).pipe(
    Effect.provideService(Crypto.Crypto, crypto),
    Effect.mapError(
      () =>
        new AuthenticationError({
          message: "Request authentication could not be evaluated"
        })
    )
  )
}

const workerClientAuthenticatorLayer = (config: WorkerRuntimeConfig) =>
  Layer.effect(
    ClientAuthenticator,
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto
      return ClientAuthenticator.of({
        authenticate: (request) => authenticate(crypto, bearerToken(request), config.clientToken)
      })
    })
  )

const workerAdminAuthenticatorLayer = (config: WorkerRuntimeConfig) =>
  Layer.effect(
    AdminAuthenticator,
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto
      return AdminAuthenticator.of({
        authenticate: (request) =>
          authenticate(
            crypto,
            request.headers.get("x-ai-router-admin-token")?.trim(),
            config.adminToken
          )
      })
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
  const objectId = config.routerState.idFromName("global")
  const stub = config.routerState.get(objectId)
  const internalToken = Redacted.value(config.adminToken)
  const authenticators = Layer.merge(
    workerClientAuthenticatorLayer(config),
    workerAdminAuthenticatorLayer(config)
  ).pipe(Layer.provide(BrowserCrypto.layer))

  const layer = Layer.unwrap(
    importCredentialKeyring(config.credentialKeyring).pipe(
      Effect.provide(BrowserCrypto.layer),
      Effect.map((cipher) =>
        Layer.mergeAll(
          BrowserCrypto.layer,
          durableObjectRoutingStateLayer(stub),
          durableSubscriptionRouterLayer(stub, cipher, internalToken),
          authenticators,
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
              relayToken: config.relayToken,
              runToken: config.aiGatewayRunToken
            })
          ),
          workerTelemetryLayer
        )
      )
    )
  )
  const runtime = ManagedRuntime.make(layer)
  try {
    const workerFetch: RouterFetch = await runtime.runPromise(makeWorkerFetch())
    const router = await runtime.runPromise(SubscriptionRouter)
    return {
      close: runtime.dispose,
      fetch: workerFetch,
      maintain: (now: number) => runtime.runPromise(router.maintain(now))
    }
  } catch (error) {
    await runtime.dispose()
    throw error
  }
}
