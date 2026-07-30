import * as BunHttpClient from "@effect/platform-bun/BunHttpClient"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import { Console, Effect, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"

class InspectionError extends Schema.TaggedErrorClass<InspectionError>()("InspectionError", {
  message: Schema.String
}) {}

const failure = () =>
  new InspectionError({
    message: "AI Gateway log inspection failed"
  })

const LogSummary = Schema.Struct({
  id: Schema.String,
  cached: Schema.optionalKey(Schema.Boolean),
  created_at: Schema.optionalKey(Schema.String),
  duration: Schema.optionalKey(Schema.Number),
  metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  path: Schema.optionalKey(Schema.String),
  provider: Schema.optionalKey(Schema.String),
  status_code: Schema.optionalKey(Schema.Number)
})

const LogDetail = Schema.Struct({
  id: Schema.String,
  cached: Schema.optionalKey(Schema.Boolean),
  created_at: Schema.optionalKey(Schema.String),
  duration: Schema.optionalKey(Schema.Number),
  metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  path: Schema.optionalKey(Schema.String),
  prompts: Schema.optionalKey(Schema.Unknown),
  provider: Schema.optionalKey(Schema.String),
  request: Schema.optionalKey(Schema.Unknown),
  response: Schema.optionalKey(Schema.Unknown),
  status_code: Schema.optionalKey(Schema.Number)
})

const ListEnvelope = Schema.Struct({
  result: Schema.Array(LogSummary),
  success: Schema.Boolean
})

const DetailEnvelope = Schema.Struct({
  result: LogDetail,
  success: Schema.Boolean
})

const Environment = Schema.Struct({
  CF_ACCOUNT_ID: Schema.String.check(Schema.isNonEmpty()),
  CF_AIG_GATEWAY_ID: Schema.String.check(Schema.isNonEmpty()),
  CF_AIG_LOG_ID: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty())),
  CLOUDFLARE_API_TOKEN: Schema.String.check(Schema.isNonEmpty())
})

const storedLength = (value: unknown): number => {
  if (value === undefined || value === null) {
    return 0
  }
  if (typeof value === "string" || Array.isArray(value)) {
    return value.length
  }
  return -1
}

const cloudflareGet = Effect.fn("cloudflareGet")(function* <A, I, R>(
  path: string,
  token: Redacted.Redacted<string>,
  schema: Schema.Codec<A, I, R>
) {
  const client = yield* HttpClient.HttpClient
  const request = HttpClientRequest.get(`https://api.cloudflare.com/client/v4${path}`).pipe(
    HttpClientRequest.bearerToken(token)
  )
  const response = yield* client.execute(request).pipe(Effect.mapError(failure))
  if (response.status < 200 || response.status >= 300) {
    return yield* failure()
  }
  const body = yield* response.json.pipe(Effect.mapError(failure))
  return yield* Schema.decodeUnknownEffect(schema)(body).pipe(Effect.mapError(failure))
})

export const inspectAiGatewayLog = Effect.fn("inspectAiGatewayLog")(function* (options: {
  readonly accountId: string
  readonly gatewayId: string
  readonly logId?: string
  readonly token: Redacted.Redacted<string>
}) {
  const root =
    `/accounts/${encodeURIComponent(options.accountId)}` +
    `/ai-gateway/gateways/${encodeURIComponent(options.gatewayId)}/logs`
  const logId =
    options.logId ??
    (yield* cloudflareGet(`${root}?page=1&per_page=1`, options.token, ListEnvelope)).result[0]?.id
  if (logId === undefined) {
    return yield* failure()
  }
  const detail = (yield* cloudflareGet(
    `${root}/${encodeURIComponent(logId)}`,
    options.token,
    DetailEnvelope
  )).result
  return {
    cached: detail.cached ?? null,
    createdAt: detail.created_at ?? null,
    durationMs: detail.duration ?? null,
    id: detail.id,
    metadata: detail.metadata ?? {},
    path: detail.path ?? null,
    payloadLengths: {
      prompts: storedLength(detail.prompts),
      request: storedLength(detail.request),
      response: storedLength(detail.response)
    },
    provider: detail.provider ?? null,
    statusCode: detail.status_code ?? null
  }
})

const main = Effect.gen(function* () {
  const environment = yield* Schema.decodeUnknownEffect(Environment)(process.env).pipe(
    Effect.mapError(failure)
  )
  const result = yield* inspectAiGatewayLog({
    accountId: environment.CF_ACCOUNT_ID,
    gatewayId: environment.CF_AIG_GATEWAY_ID,
    ...(environment.CF_AIG_LOG_ID === undefined ? {} : { logId: environment.CF_AIG_LOG_ID }),
    token: Redacted.make(environment.CLOUDFLARE_API_TOKEN)
  })
  yield* Console.log(JSON.stringify(result))
})

if (import.meta.main) {
  BunRuntime.runMain(
    main.pipe(
      Effect.catch(() =>
        Console.error("AI Gateway log inspection failed").pipe(
          Effect.andThen(Effect.fail(failure()))
        )
      ),
      Effect.provide(BunHttpClient.layer)
    )
  )
}
