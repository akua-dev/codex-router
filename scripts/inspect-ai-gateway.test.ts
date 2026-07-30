import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Redacted } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { inspectAiGatewayLog } from "./inspect-ai-gateway.ts"

describe("AI Gateway inspection", () => {
  it.effect("uses the Effect HTTP client and returns only sanitized log metadata", () =>
    Effect.gen(function* () {
      const requests: Array<string> = []
      const client = HttpClient.make((request) => {
        requests.push(request.url)
        expect(request.headers.authorization).toBe("Bearer cloudflare-secret")
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            request.url.endsWith("/logs?page=1&per_page=1")
              ? Response.json({
                  result: [
                    {
                      id: "log-a",
                      path: "synthetic/sse",
                      status_code: 200
                    }
                  ],
                  success: true
                })
              : Response.json({
                  result: {
                    cached: false,
                    duration: 42,
                    id: "log-a",
                    metadata: { protocol: "responses" },
                    path: "synthetic/sse",
                    prompts: [],
                    provider: "custom-subscription",
                    request: "",
                    response: "",
                    status_code: 200
                  },
                  success: true
                })
          )
        )
      })

      const result = yield* inspectAiGatewayLog({
        accountId: "account",
        gatewayId: "gateway",
        token: Redacted.make("cloudflare-secret")
      }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, client)))

      expect(requests).toHaveLength(2)
      expect(result).toMatchObject({
        cached: false,
        durationMs: 42,
        id: "log-a",
        payloadLengths: {
          prompts: 0,
          request: 0,
          response: 0
        },
        statusCode: 200
      })
      expect(JSON.stringify(result)).not.toContain("cloudflare-secret")
    })
  )
})
