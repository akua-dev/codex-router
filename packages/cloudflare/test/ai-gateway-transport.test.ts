import { describe, expect, it } from "@effect/vitest"
import { Effect, Redacted } from "effect"
import { makeAiGatewayTransport } from "../src/index.ts"

describe("AI Gateway transport", () => {
  it.effect("uses the provider-specific endpoint with metadata-only logging and no retries", () =>
    Effect.gen(function* () {
      let forwarded: Request | undefined
      const transport = makeAiGatewayTransport({
        accountId: "cf-account",
        customProviderSlug: "codex-subscription",
        fetch: (request) => {
          forwarded = request
          return Promise.resolve(new Response("upstream", { status: 202 }))
        },
        gatewayId: "router",
        metadata: {
          protocol: "responses",
          runtime: "cloudflare"
        },
        relayToken: Redacted.make("relay-secret"),
        runToken: Redacted.make("cloudflare-run-secret")
      })
      const original = new Request("https://chatgpt.com/backend-api/codex/responses?stream=true", {
        body: '{"prompt":"sensitive body"}',
        headers: {
          authorization: "Bearer provider-secret",
          "content-type": "application/json"
        },
        method: "POST"
      })

      const response = yield* transport.execute(original)

      expect(response.status).toBe(202)
      expect(forwarded).toBeDefined()
      if (forwarded === undefined) {
        return
      }
      expect(forwarded.url).toBe(
        "https://gateway.ai.cloudflare.com/v1/cf-account/router/custom-codex-subscription/backend-api/codex/responses?stream=true"
      )
      expect(forwarded.headers.get("authorization")).toBe("Bearer provider-secret")
      expect(forwarded.headers.get("cf-aig-authorization")).toBe("Bearer cloudflare-run-secret")
      expect(forwarded.headers.get("cf-aig-skip-cache")).toBe("true")
      expect(forwarded.headers.get("cf-aig-collect-log-payload")).toBe("false")
      expect(forwarded.headers.get("cf-aig-max-attempts")).toBe("1")
      expect(forwarded.headers.get("x-api-key")).toBe("relay-secret")
      const metadata = forwarded.headers.get("cf-aig-metadata")
      expect(metadata).toBe(JSON.stringify({ protocol: "responses", runtime: "cloudflare" }))
      expect(metadata).not.toContain("provider-secret")
      expect(metadata).not.toContain("sensitive body")
    })
  )

  it.effect("rejects non-subscription upstream hosts without transmitting", () =>
    Effect.gen(function* () {
      let transmitted = false
      const transport = makeAiGatewayTransport({
        accountId: "cf-account",
        customProviderSlug: "codex-subscription",
        fetch: () => {
          transmitted = true
          return Promise.resolve(new Response(null, { status: 204 }))
        },
        gatewayId: "router",
        relayToken: Redacted.make("relay-secret"),
        runToken: Redacted.make("run-token")
      })

      yield* Effect.flip(
        transport.execute(
          new Request("https://api.openai.com/v1/responses/compact", {
            body: "{}",
            method: "POST"
          })
        )
      )

      expect(transmitted).toBe(false)
    })
  )

  it.effect("rejects invalid metadata before transmitting", () =>
    Effect.gen(function* () {
      let transmitted = false
      const transport = makeAiGatewayTransport({
        accountId: "cf-account",
        customProviderSlug: "codex-subscription",
        fetch: () => {
          transmitted = true
          return Promise.resolve(new Response())
        },
        gatewayId: "router",
        metadata: {
          one: 1,
          two: 2,
          three: 3,
          four: 4,
          five: 5,
          six: 6
        },
        relayToken: Redacted.make("relay-secret"),
        runToken: Redacted.make("run-token")
      })

      yield* Effect.flip(
        transport.execute(
          new Request("https://chatgpt.com/backend-api/codex/responses", {
            body: "{}",
            method: "POST"
          })
        )
      )

      expect(transmitted).toBe(false)
    })
  )

  it.effect("restores an encapsulated SSE content type without reading response bytes", () =>
    Effect.gen(function* () {
      const expected = new TextEncoder().encode("data: opaque\n\n")
      const transport = makeAiGatewayTransport({
        accountId: "cf-account",
        customProviderSlug: "codex-subscription",
        fetch: () =>
          Promise.resolve(
            new Response(expected, {
              headers: {
                "content-type": "application/octet-stream",
                "x-codex-upstream-content-type": "text/event-stream"
              }
            })
          ),
        gatewayId: "router",
        relayToken: Redacted.make("relay-secret"),
        runToken: Redacted.make("run-token")
      })

      const response = yield* transport.execute(
        new Request("https://chatgpt.com/backend-api/codex/responses", {
          body: "{}",
          method: "POST"
        })
      )
      const actual = new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()))

      expect(response.headers.get("content-type")).toBe("text/event-stream")
      expect(response.headers.has("x-codex-upstream-content-type")).toBe(false)
      expect(actual).toEqual(expected)
    })
  )
})
