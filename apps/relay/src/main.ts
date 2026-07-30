import { decodeRelayConfig, makeCodexEgressRelay } from "@akua-dev/codex-router-relay"
import { Effect } from "effect"

const config = await Effect.runPromise(decodeRelayConfig(process.env))
const relay = makeCodexEgressRelay({ token: config.token })
const server = Bun.serve({
  fetch: relay,
  hostname: config.hostname,
  port: config.port
})

console.info(`codex-router egress relay listening on ${server.url.origin}`)

const shutdown = (): void => {
  server.stop(true)
}

process.once("SIGINT", shutdown)
process.once("SIGTERM", shutdown)
