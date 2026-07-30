import { describe, expect, it } from "@effect/vitest"
import { AccountId, RoutingState } from "@akua-dev/codex-router-core"
import {
  AccountAdmin,
  AdminAuthenticator,
  ClientAuthenticator,
  GatewayTelemetry,
  SubscriptionCredential,
  SubscriptionRouter,
  UpstreamTransport
} from "@akua-dev/codex-router-codex"
import { Effect, Redacted } from "effect"
import {
  CredentialKeyAdmin,
  CredentialKeyVersionCount,
  WorkerConfigError,
  decodeWorkerBindings,
  encodeCredentialBundle,
  importAesGcmKey,
  makeAiGatewayTransport,
  makeCredentialCipher,
  makeDurableObjectRoutingState,
  makeDurableSubscriptionRouter,
  makeWorkerFetch
} from "../src/index.ts"

const now = Date.UTC(2026, 6, 30, 12)
const accountId = AccountId.make("account-a")
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
            expiresAt: now + 3_600_000,
            observedAt: now,
            providerAccountId: "provider-a",
            refreshToken: "refresh-secret-value",
            shortResetAt: now + 60 * 60 * 1_000,
            shortUsedPercent: 10,
            weeklyResetAt: now + 7 * 24 * 60 * 60 * 1_000,
            weeklyUsedPercent: 10
          }
        ]),
        CODEX_ROUTER_ADMIN_TOKEN: "admin-secret-value",
        CODEX_ROUTER_CLIENT_TOKEN: "client-secret-value",
        CODEX_ROUTER_CREDENTIAL_KEYS_JSON: JSON.stringify({
          currentVersion: "v1",
          keys: {
            v1: base64Url(crypto.getRandomValues(new Uint8Array(32)))
          }
        }),
        CODEX_ROUTER_RELAY_TOKEN: "relay-secret-value",
        ROUTER_STATE: namespace
      })

      expect(config.aiGatewayAccountId).toBe("cf-account")
      expect(config.routerState).toBe(namespace)
      expect(JSON.stringify(config)).not.toContain("aig-secret-value")
      expect(JSON.stringify(config)).not.toContain("provider-secret-value")
      expect(JSON.stringify(config)).not.toContain("client-secret-value")
      expect(JSON.stringify(config)).not.toContain("relay-secret-value")
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
          CODEX_ROUTER_ADMIN_TOKEN: "admin",
          CODEX_ROUTER_CLIENT_TOKEN: "client",
          CODEX_ROUTER_CREDENTIAL_KEYS_JSON: JSON.stringify({
            currentVersion: "v1",
            keys: { v1: base64Url(new Uint8Array(32)) }
          }),
          CODEX_ROUTER_RELAY_TOKEN: "relay",
          ROUTER_STATE: {}
        })
      )

      expect(error).toBeInstanceOf(WorkerConfigError)
    })
  )

  it.effect("rejects shared trust tokens and invalid keyrings without exposing them", () =>
    Effect.gen(function* () {
      const namespace = {
        get: () => ({ fetch: () => Promise.resolve(new Response()) }),
        idFromName: () => "global"
      }
      const error = yield* Effect.flip(
        decodeWorkerBindings({
          CF_AIG_ACCOUNT_ID: "cf-account",
          CF_AIG_CUSTOM_PROVIDER_SLUG: "codex-subscription",
          CF_AIG_GATEWAY_ID: "router",
          CF_AIG_TOKEN: "token",
          CODEX_ROUTER_ADMIN_TOKEN: "shared-secret",
          CODEX_ROUTER_CLIENT_TOKEN: "shared-secret",
          CODEX_ROUTER_CREDENTIAL_KEYS_JSON: JSON.stringify({
            currentVersion: "missing",
            keys: { v1: "invalid-key" }
          }),
          CODEX_ROUTER_RELAY_TOKEN: "shared-secret",
          ROUTER_STATE: namespace
        })
      )

      expect(error).toBeInstanceOf(WorkerConfigError)
      expect(error.message).not.toContain("shared-secret")
      expect(error.message).not.toContain("invalid-key")
    })
  )
})

{
  const rpcBodies: Array<string> = []
  const order: Array<string> = []
  const cipherKey = await Effect.runPromise(
    importAesGcmKey(crypto.getRandomValues(new Uint8Array(32)))
  )
  const cipher = makeCredentialCipher({
    currentVersion: "v1",
    keys: new Map([["v1", cipherKey]])
  })
  const credential = SubscriptionCredential.make({
    accessToken: Redacted.make("provider-secret"),
    accountId,
    expiresAt: Number.MAX_SAFE_INTEGER,
    generation: 3,
    providerAccountId: Redacted.make("provider-a"),
    refreshToken: Redacted.make("refresh-secret")
  })
  const envelope = await Effect.runPromise(
    cipher.encrypt(accountId, credential.generation, encodeCredentialBundle(credential))
  )
  const stub = {
    async fetch(request: Request): Promise<Response> {
      const path = new URL(request.url).pathname
      const body = await request.text()
      rpcBodies.push(body)
      order.push(`rpc:${path}`)
      if (path === "/route/acquire") {
        return Response.json({
          accountId,
          credential: {
            ...envelope,
            generation: credential.generation
          },
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
  const aiGatewayRequests: Array<Request> = []
  const adminAuthenticator = AdminAuthenticator.of({
    authenticate: (request) =>
      Effect.succeed(request.headers.get("x-ai-router-admin-token") === "admin-secret")
  })
  const keyAdmin = CredentialKeyAdmin.of({
    counts: () => Effect.succeed([CredentialKeyVersionCount.make({ count: 1, keyVersion: "v1" })])
  })
  const adminService = AccountAdmin.of({
    list: () => Effect.succeed([]),
    putCredential: () => Effect.die("not used"),
    remove: () => Effect.die("not used"),
    setEnabled: () => Effect.die("not used")
  })
  const clientAuthenticator = ClientAuthenticator.of({
    authenticate: (request) =>
      Effect.succeed(request.headers.get("x-ai-router-token") === "client-token")
  })
  const routerService = makeDurableSubscriptionRouter(stub, cipher, "admin-secret")
  const upstream = makeAiGatewayTransport({
    accountId: "cf-account",
    customProviderSlug: "codex-subscription",
    fetch: async (request) => {
      aiGatewayRequests.push(request)
      order.push("ai-gateway")
      await request.arrayBuffer()
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: done\n\n"))
            controller.close()
          }
        }),
        {
          headers: {
            "content-type": "application/octet-stream",
            "x-codex-upstream-content-type": "text/event-stream"
          }
        }
      )
    },
    gatewayId: "router",
    metadata: { runtime: "cloudflare" },
    relayToken: Redacted.make("relay-token"),
    runToken: Redacted.make("aig-run-token")
  })
  const telemetry = GatewayTelemetry.of({
    bookkeepingFailure: () => Effect.void,
    decision: () => Effect.void
  })
  const routingState = makeDurableObjectRoutingState(stub)

  describe("Worker request path", () => {
    it("keeps telemetry payloads out of DO RPC and streams only through AI Gateway", async () => {
      const fetch = await Effect.runPromise(
        makeWorkerFetch().pipe(
          Effect.provideService(AccountAdmin, adminService),
          Effect.provideService(AdminAuthenticator, adminAuthenticator),
          Effect.provideService(ClientAuthenticator, clientAuthenticator),
          Effect.provideService(CredentialKeyAdmin, keyAdmin),
          Effect.provideService(GatewayTelemetry, telemetry),
          Effect.provideService(RoutingState, routingState),
          Effect.provideService(SubscriptionRouter, routerService),
          Effect.provideService(UpstreamTransport, upstream)
        )
      )
      const health = await fetch(new Request("https://worker.invalid/healthz"))
      let adminBodyPulled = false
      const adminBody = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            adminBodyPulled = true
            controller.enqueue(new TextEncoder().encode("{}"))
            controller.close()
          }
        },
        { highWaterMark: 0 }
      )
      const adminUnauthorized = await fetch(
        new Request("https://worker.invalid/admin/accounts/account-a/credential", {
          body: adminBody,
          duplex: "half",
          method: "PUT"
        } as RequestInit & { readonly duplex: "half" })
      )
      const response = await fetch(
        new Request("https://worker.invalid/responses", {
          body: '{"prompt":"sensitive prompt body"}',
          headers: { "x-ai-router-token": "client-token" },
          method: "POST"
        })
      )
      const keyVersions = await fetch(
        new Request("https://worker.invalid/admin/key-versions", {
          headers: { "x-ai-router-admin-token": "admin-secret" }
        })
      )
      const canary = await fetch(
        new Request("https://worker.invalid/admin/canary/sse", {
          headers: { "x-ai-router-admin-token": "admin-secret" }
        })
      )
      const body = await response.text()
      const canaryBody = await canary.text()
      const summary = await Effect.runPromise(routingState.summary(now))

      expect(health.status).toBe(200)
      expect(adminUnauthorized.status).toBe(401)
      expect(adminBodyPulled).toBe(false)
      expect(keyVersions.status).toBe(200)
      expect(await keyVersions.json()).toEqual({
        versions: [{ count: 1, keyVersion: "v1" }]
      })
      expect(body).toBe("data: done\n\n")
      expect(canary.status).toBe(200)
      expect(canaryBody).toBe("data: done\n\n")
      expect(order.indexOf("rpc:/route/acquire")).toBeLessThan(order.indexOf("ai-gateway"))
      expect(order.filter((event) => event === "rpc:/route/renew")).toHaveLength(0)
      expect(
        order.filter((event) =>
          ["rpc:/route/acquire", "rpc:/route/record-response", "rpc:/route/release"].includes(event)
        )
      ).toHaveLength(3)
      expect(rpcBodies.join(" ")).toContain('"generation":3')
      expect(rpcBodies.join(" ")).not.toContain("sensitive prompt body")
      const aiGatewayRequest = aiGatewayRequests.find((request) =>
        request.url.includes("/backend-api/codex/responses")
      )
      const canaryRequest = aiGatewayRequests.find((request) =>
        request.url.includes("/synthetic/sse")
      )
      expect(aiGatewayRequest).toBeDefined()
      expect(canaryRequest).toBeDefined()
      if (aiGatewayRequest === undefined || canaryRequest === undefined) {
        return
      }
      expect(aiGatewayRequest.headers.get("cf-aig-authorization")).toBe("Bearer aig-run-token")
      expect(aiGatewayRequest.headers.get("cf-aig-collect-log-payload")).toBe("false")
      expect(aiGatewayRequest.headers.get("x-api-key")).toBe("relay-token")
      expect(canaryRequest.url).toBe(
        "https://gateway.ai.cloudflare.com/v1/cf-account/router/custom-codex-subscription/synthetic/sse"
      )
      expect(canaryRequest.headers.get("x-api-key")).toBe("relay-token")
      expect(response.headers.has("cf-aig-authorization")).toBe(false)
      expect(summary.activeReservations).toBe(0)
    })
  })
}
