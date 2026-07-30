import { AccountId } from "@akua-dev/codex-router-core"
import { Effect, Redacted, Schema } from "effect"

export class ConfiguredAccount extends Schema.Class<ConfiguredAccount>("ConfiguredAccount")({
  accountId: AccountId,
  accessToken: Schema.RedactedFromValue(Schema.String),
  providerAccountId: Schema.optionalKey(Schema.String),
  observedAt: Schema.Number,
  shortUsedPercent: Schema.Number,
  shortResetAt: Schema.Number,
  weeklyUsedPercent: Schema.Number,
  weeklyResetAt: Schema.Number
}) {}

export class BunRuntimeConfig extends Schema.Class<BunRuntimeConfig>("BunRuntimeConfig")({
  port: Schema.Number,
  hostname: Schema.String,
  databasePath: Schema.String,
  clientToken: Schema.Redacted(Schema.String),
  accounts: Schema.Array(ConfiguredAccount)
}) {}

export class BunConfigError extends Schema.TaggedErrorClass<BunConfigError>()("BunConfigError", {
  message: Schema.String
}) {}

const Environment = Schema.Struct({
  CODEX_ROUTER_CLIENT_TOKEN: Schema.String,
  CODEX_ROUTER_ACCOUNTS_JSON: Schema.String,
  CODEX_ROUTER_DATABASE_PATH: Schema.optionalKey(Schema.String),
  PORT: Schema.optionalKey(Schema.String),
  HOST: Schema.optionalKey(Schema.String)
})

const decodeEnvironment = Schema.decodeUnknownEffect(Environment)
const decodeAccounts = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(ConfiguredAccount))
)

const configFailure = () =>
  new BunConfigError({
    message: "The Bun router configuration is invalid; secret values were redacted"
  })

const parsePort = (value: string | undefined): Effect.Effect<number, BunConfigError> =>
  Effect.try({
    try: () => {
      const port = value === undefined ? 8787 : Number(value)
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error("invalid port")
      }
      return port
    },
    catch: configFailure
  })

export const decodeBunConfig = Effect.fn("decodeBunConfig")(function* (input: unknown) {
  const environment = yield* decodeEnvironment(input).pipe(Effect.mapError(configFailure))
  const accounts = yield* decodeAccounts(environment.CODEX_ROUTER_ACCOUNTS_JSON).pipe(
    Effect.mapError(configFailure)
  )
  if (accounts.length === 0) {
    return yield* configFailure()
  }
  const port = yield* parsePort(environment.PORT)

  return BunRuntimeConfig.make({
    accounts,
    clientToken: Redacted.make(environment.CODEX_ROUTER_CLIENT_TOKEN),
    databasePath: environment.CODEX_ROUTER_DATABASE_PATH ?? "./data/codex-router.sqlite",
    hostname: environment.HOST ?? "0.0.0.0",
    port
  })
})
