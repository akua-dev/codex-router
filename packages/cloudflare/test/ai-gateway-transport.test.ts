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
      const metadata = forwarded.headers.get("cf-aig-metadata")
      expect(metadata).toBe(JSON.stringify({ protocol: "responses", runtime: "cloudflare" }))
      expect(metadata).not.toContain("provider-secret")
      expect(metadata).not.toContain("sensitive body")
    })
  )

  it.effect("maps standard OpenAI v1 paths to the native provider endpoint", () =>
    Effect.gen(function* () {
      let url: string | undefined
      const transport = makeAiGatewayTransport({
        accountId: "cf-account",
        customProviderSlug: "codex-subscription",
        fetch: (request) => {
          url = request.url
          return Promise.resolve(new Response(null, { status: 204 }))
        },
        gatewayId: "router",
        runToken: Redacted.make("run-token")
      })

      yield* transport.execute(
        new Request("https://api.openai.com/v1/responses/compact", {
          body: "{}",
          method: "POST"
        })
      )

      expect(url).toBe(
        "https://gateway.ai.cloudflare.com/v1/cf-account/router/openai/responses/compact"
      )
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
})
