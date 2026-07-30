import { expect, layer } from "@effect/vitest"
import {
  AccountId,
  Candidate,
  UsageSnapshot,
  UsageWindow,
  defaultRoutingConfig,
  inMemoryRoutingStateLayer
} from "@akua-dev/codex-router-core"
import {
  AccountCredential,
  AccountDirectory,
  ClientAuthenticator,
  GatewayTelemetry,
  UpstreamTransport
} from "@akua-dev/codex-router-codex"
import { Effect, Layer, Redacted } from "effect"
import { makeBunFetch } from "../src/index.ts"

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
      usedPercent: 5
    }),
    weekly: UsageWindow.make({
      resetAt: now + 7 * 24 * 60 * 60 * 1_000,
      usedPercent: 5
    })
  })
})

const testLayer = Layer.mergeAll(
  inMemoryRoutingStateLayer(defaultRoutingConfig),
  Layer.succeed(
    ClientAuthenticator,
    ClientAuthenticator.of({
      authenticate: (request) =>
        Effect.succeed(request.headers.get("x-ai-router-token") === "client-secret")
    })
  ),
  Layer.succeed(
    AccountDirectory,
    AccountDirectory.of({
      candidates: Effect.succeed([candidate]),
      credential: () =>
        Effect.succeed(
          AccountCredential.make({
            accessToken: Redacted.make("upstream-secret"),
            accountId,
            providerAccountId: "provider-a"
          })
        )
    })
  ),
  Layer.succeed(
    UpstreamTransport,
    UpstreamTransport.of({
      execute: () =>
        Effect.succeed(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("data: done\n\n"))
                controller.close()
              }
            }),
            {
              headers: { "content-type": "text/event-stream" }
            }
          )
        )
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

layer(testLayer)("Bun HTTP composition", (it) => {
  it.effect("serves health, authenticated status, and the shared streaming router", () =>
    Effect.gen(function* () {
      const fetch = yield* makeBunFetch()
      const health = yield* Effect.promise(() => fetch(new Request("http://localhost/healthz")))
      const unauthorized = yield* Effect.promise(() =>
        fetch(new Request("http://localhost/status"))
      )
      const status = yield* Effect.promise(() =>
        fetch(
          new Request("http://localhost/status", {
            headers: { "x-ai-router-token": "client-secret" }
          })
        )
      )
      const response = yield* Effect.promise(() =>
        fetch(
          new Request("http://localhost/responses", {
            body: "{}",
            headers: { "x-ai-router-token": "client-secret" },
            method: "POST"
          })
        )
      )

      expect(health.status).toBe(200)
      expect(yield* Effect.promise(() => health.json())).toEqual({ status: "ok" })
      expect(unauthorized.status).toBe(401)
      expect(status.status).toBe(200)
      expect(JSON.stringify(yield* Effect.promise(() => status.json()))).not.toContain("secret")
      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.text())).toBe("data: done\n\n")
    })
  )
})
