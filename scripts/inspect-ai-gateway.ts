import { Effect, Redacted, Schema } from "effect"

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
  const response = yield* Effect.tryPromise({
    try: () =>
      fetch(`https://api.cloudflare.com/client/v4${path}`, {
        headers: { authorization: `Bearer ${Redacted.value(token)}` }
      }),
    catch: failure
  })
  if (!response.ok) {
    return yield* failure()
  }
  const body = yield* Effect.tryPromise({
    try: () => response.json(),
    catch: failure
  })
  return yield* Schema.decodeUnknownEffect(schema)(body).pipe(Effect.mapError(failure))
})

const main = Effect.gen(function* () {
  const environment = yield* Schema.decodeUnknownEffect(Environment)(process.env).pipe(
    Effect.mapError(failure)
  )
  const token = Redacted.make(environment.CLOUDFLARE_API_TOKEN)
  const root =
    `/accounts/${encodeURIComponent(environment.CF_ACCOUNT_ID)}` +
    `/ai-gateway/gateways/${encodeURIComponent(environment.CF_AIG_GATEWAY_ID)}/logs`
  const logId =
    environment.CF_AIG_LOG_ID ??
    (yield* cloudflareGet(`${root}?page=1&per_page=1`, token, ListEnvelope)).result[0]?.id
  if (logId === undefined) {
    return yield* failure()
  }
  const detail = (yield* cloudflareGet(
    `${root}/${encodeURIComponent(logId)}`,
    token,
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

if (import.meta.main) {
  Effect.runPromise(main).then(
    (result) => console.log(JSON.stringify(result)),
    () => {
      console.error("AI Gateway log inspection failed")
      process.exitCode = 1
    }
  )
}
