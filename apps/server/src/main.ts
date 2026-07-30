import { decodeBunConfig, makeBunApplication, startBunServer } from "@akua-dev/codex-router-bun"
import { Effect } from "effect"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

const main = async (): Promise<void> => {
  const config = await Effect.runPromise(decodeBunConfig(process.env))
  mkdirSync(dirname(config.databasePath), { recursive: true })
  const application = await makeBunApplication(config)
  const server = startBunServer({
    fetch: application.fetch,
    hostname: config.hostname,
    port: config.port
  })

  console.info(`codex-router listening on ${server.url.origin}`)

  const shutdown = async (): Promise<void> => {
    server.stop(true)
    await application.close()
  }
  process.once("SIGINT", () => {
    void shutdown()
  })
  process.once("SIGTERM", () => {
    void shutdown()
  })
}

await main()
