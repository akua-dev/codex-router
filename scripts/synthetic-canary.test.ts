import { describe, expect, it } from "@effect/vitest"
import { Effect, Redacted } from "effect"
import {
  SyntheticCanaryError,
  runSyntheticCanary,
  syntheticCanaryExpectedBytes
} from "./synthetic-canary.ts"

describe("synthetic deployed canary client", () => {
  it.effect("checks exact bytes, first-byte timing, completion timing, and one request", () =>
    Effect.gen(function* () {
      let requests = 0
      const clockValues = [0, 10, 100]
      const split = syntheticCanaryExpectedBytes.length - 14
      const result = yield* runSyntheticCanary({
        adminToken: Redacted.make("admin-secret"),
        clock: () => clockValues.shift() ?? 100,
        fetch: async (request) => {
          requests += 1
          expect(request.headers.get("x-ai-router-admin-token")).toBe("admin-secret")
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(syntheticCanaryExpectedBytes.slice(0, split))
                controller.enqueue(syntheticCanaryExpectedBytes.slice(split))
                controller.close()
              }
            }),
            {
              headers: {
                "content-type": "text/event-stream",
                "x-codex-canary": "synthetic"
              }
            }
          )
        },
        url: "https://router.invalid"
      })

      expect(result.bytes).toBe(syntheticCanaryExpectedBytes.length)
      expect(result.firstByteMs).toBeLessThan(result.totalMs)
      expect(result.requestCount).toBe(1)
      expect(result.status).toBe(200)
      expect(requests).toBe(1)
    })
  )

  it.effect("fails with a sanitized typed error when any byte changes", () =>
    Effect.gen(function* () {
      const changed = syntheticCanaryExpectedBytes.slice()
      changed[0] = 0
      const failure = yield* Effect.flip(
        runSyntheticCanary({
          adminToken: Redacted.make("admin-secret"),
          fetch: async () =>
            new Response(changed, {
              headers: {
                "content-type": "text/event-stream",
                "x-codex-canary": "synthetic"
              }
            }),
          url: "https://router.invalid"
        })
      )

      expect(failure).toBeInstanceOf(SyntheticCanaryError)
      expect(failure.message).not.toContain("admin-secret")
      expect(failure.message).not.toContain("data:")
    })
  )
})
