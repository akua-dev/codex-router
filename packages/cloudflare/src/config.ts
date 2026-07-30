import { AccountId } from "@akua-dev/codex-router-core"
import { Effect, Redacted, Schema } from "effect"

export interface RouterStateStub {
  readonly fetch: (request: Request) => Promise<Response>
}

export interface RouterStateNamespace {
  readonly idFromName: (name: string) => unknown
  readonly get: (id: unknown) => RouterStateStub
}

export class WorkerConfiguredAccount extends Schema.Class<WorkerConfiguredAccount>(
  "WorkerConfiguredAccount"
)({
  accountId: AccountId,
  accessToken: Schema.RedactedFromValue(Schema.String),
  expiresAt: Schema.Number,
  providerAccountId: Schema.RedactedFromValue(Schema.String),
  refreshToken: Schema.RedactedFromValue(Schema.String),
  observedAt: Schema.Number,
  shortUsedPercent: Schema.Number,
  shortResetAt: Schema.Number,
  weeklyUsedPercent: Schema.Number,
  weeklyResetAt: Schema.Number
}) {}

export interface WorkerRuntimeConfig {
  readonly aiGatewayAccountId: string
  readonly aiGatewayGatewayId: string
  readonly aiGatewayCustomProviderSlug: string
  readonly aiGatewayRunToken: Redacted.Redacted<string>
  readonly clientToken: Redacted.Redacted<string>
  readonly credentialKey: Redacted.Redacted<string>
  readonly accounts: ReadonlyArray<WorkerConfiguredAccount>
  readonly routerState: RouterStateNamespace
}

export class WorkerConfigError extends Schema.TaggedErrorClass<WorkerConfigError>()(
  "WorkerConfigError",
  {
    message: Schema.String
  }
) {}

const Bindings = Schema.Struct({
  CF_AIG_ACCOUNT_ID: Schema.String,
  CF_AIG_GATEWAY_ID: Schema.String,
  CF_AIG_CUSTOM_PROVIDER_SLUG: Schema.String,
  CF_AIG_TOKEN: Schema.String,
  CODEX_ROUTER_CLIENT_TOKEN: Schema.String,
  CODEX_ROUTER_CREDENTIAL_KEY: Schema.String,
  CODEX_ROUTER_ACCOUNTS_JSON: Schema.String,
  ROUTER_STATE: Schema.Unknown
})

const decodeBindings = Schema.decodeUnknownEffect(Bindings)
const decodeAccounts = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(WorkerConfiguredAccount))
)

const configFailure = () =>
  new WorkerConfigError({
    message: "The Worker bindings are invalid; secret values were redacted"
  })

const isRouterStateNamespace = (input: unknown): input is RouterStateNamespace => {
  if (typeof input !== "object" || input === null) {
    return false
  }
  return (
    "idFromName" in input &&
    typeof input.idFromName === "function" &&
    "get" in input &&
    typeof input.get === "function"
  )
}

const credentialKeyHasValidLength = (value: string): boolean => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    return false
  }
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/")
    const padding = "=".repeat((4 - (base64.length % 4)) % 4)
    return atob(base64 + padding).length === 32
  } catch {
    return false
  }
}

export const decodeWorkerBindings = Effect.fn("decodeWorkerBindings")(function* (input: unknown) {
  const bindings = yield* decodeBindings(input).pipe(Effect.mapError(configFailure))
  const accounts = yield* decodeAccounts(bindings.CODEX_ROUTER_ACCOUNTS_JSON).pipe(
    Effect.mapError(configFailure)
  )
  if (
    accounts.length === 0 ||
    !isRouterStateNamespace(bindings.ROUTER_STATE) ||
    !credentialKeyHasValidLength(bindings.CODEX_ROUTER_CREDENTIAL_KEY)
  ) {
    return yield* configFailure()
  }

  return {
    accounts,
    aiGatewayAccountId: bindings.CF_AIG_ACCOUNT_ID,
    aiGatewayCustomProviderSlug: bindings.CF_AIG_CUSTOM_PROVIDER_SLUG,
    aiGatewayGatewayId: bindings.CF_AIG_GATEWAY_ID,
    aiGatewayRunToken: Redacted.make(bindings.CF_AIG_TOKEN),
    clientToken: Redacted.make(bindings.CODEX_ROUTER_CLIENT_TOKEN),
    credentialKey: Redacted.make(bindings.CODEX_ROUTER_CREDENTIAL_KEY),
    routerState: bindings.ROUTER_STATE
  } satisfies WorkerRuntimeConfig
})
