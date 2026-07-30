import { codexEgressRelayRoutes, decodeRelayConfig } from "@akua-dev/codex-router-relay"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import { Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"

const main = Effect.gen(function* () {
  const config = yield* decodeRelayConfig(process.env)
  const infrastructure = Layer.merge(
    BunCrypto.layer,
    BunHttpServer.layer({
      hostname: config.hostname,
      port: config.port
    })
  )
  const served = HttpRouter.serve(codexEgressRelayRoutes({ token: config.token }), {
    disableListenLog: false,
    disableLogger: false
  }).pipe(Layer.provide(infrastructure))
  return yield* Layer.launch(Layer.merge(infrastructure, served))
})

BunRuntime.runMain(main)
