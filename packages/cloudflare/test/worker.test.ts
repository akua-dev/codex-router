import { describe, expect, it, layer } from "@effect/vitest"
import {
  AccountId,
  Candidate,
  RoutingState,
  UsageSnapshot,
  UsageWindow
} from "@akua-dev/codex-router-core"
import {
  AccountCredential,
  AccountDirectory,
  ClientAuthenticator,
  GatewayTelemetry,
  UpstreamTransport
} from "@akua-dev/codex-router-codex"
import { Effect, Layer, Redacted } from "effect"
import {
  WorkerConfigError,
  decodeWorkerBindings,
  durableObjectRoutingStateLayer,
  makeAiGatewayTransport,
  makeWorkerFetch
} from "../src/index.ts"

const now = Date.UTC(2026, 6, 30, 12)
const accountId = AccountId.make("account-a")
const candidate = Candidate.make({
  accountId,
  activeReservations: 0,
  requiresReauthentication: false,
  usage: UsageSnapshot.make({
    accountId,
    observedAt: now,
    short: UsageWindow.make({
      resetAt: now + 60 * 60 * 1_000,
      usedPercent: 10
    }),
    weekly: UsageWindow.make({
      resetAt: now + 7 * 24 * 60 * 60 * 1_000,
      usedPercent: 10
    })
  })
})

const base64Url = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")
}

describe("worker bindings", () => {
  it.effect("schema-decodes bindings while redacting all secrets", () =>
    Effect.gen(function* () {
      const stub = { fetch: () => Promise.resolve(new Response()) }
      const namespace = {
        get: () => stub,
        idFromName: () => ({ toString: () => "global" })
      }
      const config = yield* decodeWorkerBindings({
        CF_AIG_ACCOUNT_ID: "cf-account",
        CF_AIG_CUSTOM_PROVIDER_SLUG: "codex-subscription",
        CF_AIG_GATEWAY_ID: "router",
        CF_AIG_TOKEN: "aig-secret-value",
        CODEX_ROUTER_ACCOUNTS_JSON: JSON.stringify([
          {
            accessToken: "provider-secret-value",
            accountId: "account-a",
            kind: "codex_subscription",
            observedAt: now,
            providerAccountId: "provider-a",
            shortResetAt: now + 60 * 60 * 1_000,
            shortUsedPercent: 10,
            weeklyResetAt: now + 7 * 24 * 60 * 60 * 1_000,
            weeklyUsedPercent: 10
          }
        ]),
        CODEX_ROUTER_CLIENT_TOKEN: "client-secret-value",
        CODEX_ROUTER_CREDENTIAL_KEY: base64Url(crypto.getRandomValues(new Uint8Array(32))),
        ROUTER_STATE: namespace
      })

      expect(config.aiGatewayAccountId).toBe("cf-account")
      expect(config.routerState).toBe(namespace)
      expect(JSON.stringify(config)).not.toContain("aig-secret-value")
      expect(JSON.stringify(config)).not.toContain("provider-secret-value")
      expect(JSON.stringify(config)).not.toContain("client-secret-value")
    })
  )

  it.effect("rejects a missing Durable Object namespace with a typed error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decodeWorkerBindings({
          CF_AIG_ACCOUNT_ID: "cf-account",
          CF_AIG_CUSTOM_PROVIDER_SLUG: "codex-subscription",
          CF_AIG_GATEWAY_ID: "router",
          CF_AIG_TOKEN: "token",
          CODEX_ROUTER_ACCOUNTS_JSON: "[]",
          CODEX_ROUTER_CLIENT_TOKEN: "client",
          CODEX_ROUTER_CREDENTIAL_KEY: base64Url(new Uint8Array(32)),
          ROUTER_STATE: {}
        })
      )

      expect(error).toBeInstanceOf(WorkerConfigError)
    })
  )
})

{
  const rpcBodies: Array<string> = []
  const order: Array<string> = []
  const stub = {
    async fetch(request: Request): Promise<Response> {
      const path = new URL(request.url).pathname
      const body = await request.text()
      rpcBodies.push(body)
      order.push(`rpc:${path}`)
      if (path === "/acquire") {
        return Response.json({
          accountId,
          expiresAt: now + 120_000,
          leaseToken: "lease-a"
        })
      }
      if (path === "/summary") {
        return Response.json({
          accounts: [],
          activeReservations: 0,
          assignments: 0
        })
      }
      return Response.json({ ok: true })
    }
  }
  let aiGatewayRequest: Request | undefined
  const testLayer = Layer.mergeAll(
    durableObjectRoutingStateLayer(stub),
    Layer.succeed(
      ClientAuthenticator,
      ClientAuthenticator.of({
        authenticate: (request) =>
          Effect.succeed(request.headers.get("x-ai-router-token") === "client-token")
      })
    ),
    Layer.succeed(
      AccountDirectory,
      AccountDirectory.of({
        candidates: Effect.succeed([candidate]),
        credential: () =>
          Effect.succeed(
            AccountCredential.make({
              accessToken: Redacted.make("provider-secret"),
              accountId,
              kind: "codex_subscription",
              providerAccountId: "provider-a"
            })
          )
      })
    ),
    Layer.succeed(
      UpstreamTransport,
      makeAiGatewayTransport({
        accountId: "cf-account",
        customProviderSlug: "codex-subscription",
        fetch: (request) => {
          aiGatewayRequest = request
          order.push("ai-gateway")
          return Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode("data: done\n\n"))
                  controller.close()
                }
              }),
              { headers: { "content-type": "text/event-stream" } }
            )
          )
        },
        gatewayId: "router",
        metadata: { runtime: "cloudflare" },
        runToken: Redacted.make("aig-run-token")
      })
    ),
    Layer.succeed(
      GatewayTelemetry,
      GatewayTelemetry.of({
        bookkeepingFailure: () => Effect.void,
        decision: () => Effect.void
      })
    )
  )

  layer(testLayer)("Worker request path", (it) => {
    it.effect("keeps telemetry payloads out of DO RPC and streams only through AI Gateway", () =>
      Effect.gen(function* () {
        const fetch = yield* makeWorkerFetch()
        const health = yield* Effect.promise(() =>
          fetch(new Request("https://worker.invalid/healthz"))
        )
        const response = yield* Effect.promise(() =>
          fetch(
            new Request("https://worker.invalid/responses", {
              body: '{"prompt":"sensitive prompt body"}',
              headers: { "x-ai-router-token": "client-token" },
              method: "POST"
            })
          )
        )
        const body = yield* Effect.promise(() => response.text())
        const state = yield* RoutingState
        const summary = yield* state.summary(now)

        expect(health.status).toBe(200)
        expect(body).toBe("data: done\n\n")
        expect(order.indexOf("rpc:/acquire")).toBeLessThan(order.indexOf("ai-gateway"))
        expect(rpcBodies.join(" ")).not.toContain("sensitive prompt body")
        expect(aiGatewayRequest).toBeDefined()
        if (aiGatewayRequest === undefined) {
          return
        }
        expect(aiGatewayRequest.headers.get("cf-aig-authorization")).toBe("Bearer aig-run-token")
        expect(aiGatewayRequest.headers.get("cf-aig-collect-log-payload")).toBe("false")
        expect(response.headers.has("cf-aig-authorization")).toBe(false)
        expect(summary.activeReservations).toBe(0)
      })
    )
  })
}
