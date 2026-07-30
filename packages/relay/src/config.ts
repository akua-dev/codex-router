import { Effect, Redacted, Schema } from "effect"

export class RelayRuntimeConfig extends Schema.Class<RelayRuntimeConfig>("RelayRuntimeConfig")({
  hostname: Schema.String,
  port: Schema.Number,
  token: Schema.Redacted(Schema.String)
}) {}

export class RelayConfigError extends Schema.TaggedErrorClass<RelayConfigError>()(
  "RelayConfigError",
  {
    message: Schema.String
  }
) {}

const Environment = Schema.Struct({
  CODEX_ROUTER_RELAY_TOKEN: Schema.String.check(Schema.isNonEmpty()),
  HOST: Schema.optionalKey(Schema.String),
  PORT: Schema.optionalKey(Schema.String)
})

const decodeEnvironment = Schema.decodeUnknownEffect(Environment)

const configFailure = () =>
  new RelayConfigError({
    message: "The relay configuration is invalid; secret values were redacted"
  })

const parsePort = (value: string | undefined): Effect.Effect<number, RelayConfigError> =>
  Effect.try({
    try: () => {
      const port = value === undefined ? 8788 : Number(value)
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error("invalid port")
      }
      return port
    },
    catch: configFailure
  })

export const decodeRelayConfig = Effect.fn("decodeRelayConfig")(function* (input: unknown) {
  const environment = yield* decodeEnvironment(input).pipe(Effect.mapError(configFailure))
  const port = yield* parsePort(environment.PORT)
  return RelayRuntimeConfig.make({
    hostname: environment.HOST ?? "0.0.0.0",
    port,
    token: Redacted.make(environment.CODEX_ROUTER_RELAY_TOKEN)
  })
})
