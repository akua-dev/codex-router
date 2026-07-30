import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { RelayConfigError, decodeRelayConfig } from "../src/index.ts"

describe("relay configuration", () => {
  it.effect("decodes a redacted token and bounded listen address", () =>
    Effect.gen(function* () {
      const config = yield* decodeRelayConfig({
        CODEX_ROUTER_RELAY_TOKEN: "relay-secret",
        HOST: "127.0.0.1",
        PORT: "9000"
      })

      expect(config.hostname).toBe("127.0.0.1")
      expect(config.port).toBe(9000)
      expect(JSON.stringify(config)).not.toContain("relay-secret")
    })
  )

  it.effect("rejects invalid input without exposing it", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decodeRelayConfig({
          CODEX_ROUTER_RELAY_TOKEN: "relay-secret",
          PORT: "70000"
        })
      )

      expect(error).toBeInstanceOf(RelayConfigError)
      expect(error.message).not.toContain("relay-secret")
    })
  )
})
