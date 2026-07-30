import { bunServerLayer, decodeBunConfig } from "@akua-dev/codex-router-bun"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, FileSystem, Layer, Path } from "effect"

const main = Effect.gen(function* () {
  const config = yield* decodeBunConfig(process.env)
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  yield* fileSystem.makeDirectory(path.dirname(config.databasePath), {
    recursive: true
  })
  return yield* Layer.launch(bunServerLayer(config))
}).pipe(Effect.provide(BunServices.layer))

BunRuntime.runMain(main)
