import { describe, expect, it } from "@effect/vitest"
import { Effect, Redacted } from "effect"
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { makeCloudflareCodexControlTransport, type WorkerRuntimeConfig } from "../src/index.ts"

const config = {
  accounts: [],
  adminToken: Redacted.make("admin-token"),
  aiGatewayAccountId: "cf-account",
  aiGatewayCustomProviderSlug: "codex-subscription",
  aiGatewayGatewayId: "router",
  aiGatewayRunToken: Redacted.make("aig-token"),
  clientToken: Redacted.make("client-token"),
  credentialKeyring: {
    currentVersion: "v1",
    keys: new Map()
  },
  relayToken: Redacted.make("relay-token"),
  routerState: {
    get: () => ({ fetch: () => Promise.resolve(new Response()) }),
    idFromName: () => "global"
  }
} satisfies WorkerRuntimeConfig

describe("Cloudflare Codex control transport", () => {
  it.effect("keeps OAuth direct and sends usage through the privacy-locked custom provider", () =>
    Effect.gen(function* () {
      const requests: Array<HttpClientRequest.HttpClientRequest> = []
      const client = HttpClient.make((request) => {
        requests.push(request)
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ ok: true })))
      })
      const transport = makeCloudflareCodexControlTransport(config, client)

      yield* transport.execute(
        new Request("https://auth.openai.com/oauth/token", {
          body: "grant_type=refresh_token",
          method: "POST"
        })
      )
      yield* transport.execute(
        new Request("https://chatgpt.com/backend-api/wham/usage", {
          headers: {
            authorization: "Bearer subscription-secret",
            "chatgpt-account-id": "provider-account"
          }
        })
      )

      expect(requests[0]?.url).toBe("https://auth.openai.com/oauth/token")
      expect(requests[0]?.headers["cf-aig-authorization"]).toBeUndefined()
      expect(requests[1]?.url).toBe(
        "https://gateway.ai.cloudflare.com/v1/cf-account/router/custom-codex-subscription/backend-api/wham/usage"
      )
      expect(requests[1]?.headers["cf-aig-authorization"]).toBe("Bearer aig-token")
      expect(requests[1]?.headers["cf-aig-collect-log-payload"]).toBe("false")
      expect(requests[1]?.headers["cf-aig-skip-cache"]).toBe("true")
      expect(requests[1]?.headers["cf-aig-max-attempts"]).toBe("1")
      expect(requests[1]?.headers["x-api-key"]).toBe("relay-token")
      expect(requests[1]?.headers["cf-aig-metadata"]).not.toContain("provider-account")
    })
  )
})
