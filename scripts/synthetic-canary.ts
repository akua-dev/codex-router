import { Effect, Redacted, Schema } from "effect"

export const syntheticCanaryExpectedBytes = new TextEncoder().encode(
  'data: {"delta":"🌊"}\n\ndata: {"delta":"done"}\n\ndata: [DONE]\n\n'
)

export class SyntheticCanaryError extends Schema.TaggedErrorClass<SyntheticCanaryError>()(
  "SyntheticCanaryError",
  {
    message: Schema.String
  }
) {}

export class SyntheticCanaryResult extends Schema.Class<SyntheticCanaryResult>(
  "SyntheticCanaryResult"
)({
  bytes: Schema.Int,
  firstByteMs: Schema.Number,
  requestCount: Schema.Int,
  status: Schema.Int,
  totalMs: Schema.Number
}) {}

export interface SyntheticCanaryOptions {
  readonly adminToken: Redacted.Redacted<string>
  readonly clock?: () => number
  readonly fetch?: (request: Request) => Promise<Response>
  readonly url: string
}

const failure = () =>
  new SyntheticCanaryError({
    message: "The synthetic streaming canary failed"
  })

const concatenate = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.byteLength !== right.byteLength) {
    return false
  }
  let difference = 0
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return difference === 0
}

export const runSyntheticCanary = Effect.fn("runSyntheticCanary")(function* (
  options: SyntheticCanaryOptions
) {
  const clock = options.clock ?? performance.now.bind(performance)
  const target = yield* Effect.try({
    try: () => new URL("/admin/canary/sse", options.url),
    catch: failure
  })
  const startedAt = clock()
  let requestCount = 0
  const response = yield* Effect.tryPromise({
    try: () => {
      requestCount += 1
      return (options.fetch ?? fetch)(
        new Request(target, {
          headers: {
            accept: "text/event-stream",
            "x-ai-router-admin-token": Redacted.value(options.adminToken)
          },
          method: "GET"
        })
      )
    },
    catch: failure
  })
  if (
    response.status !== 200 ||
    !response.headers.get("content-type")?.includes("text/event-stream") ||
    response.headers.get("x-codex-canary") !== "synthetic" ||
    response.body === null
  ) {
    return yield* failure()
  }

  const reader = response.body.getReader()
  const chunks: Array<Uint8Array> = []
  let firstByteAt: number | undefined
  while (true) {
    const next = yield* Effect.tryPromise({
      try: () => reader.read(),
      catch: failure
    })
    if (next.done) {
      break
    }
    if (next.value.byteLength > 0) {
      firstByteAt ??= clock()
      chunks.push(next.value)
    }
  }
  const completedAt = clock()
  const actual = concatenate(chunks)
  if (
    firstByteAt === undefined ||
    completedAt <= firstByteAt ||
    requestCount !== 1 ||
    !equalBytes(actual, syntheticCanaryExpectedBytes)
  ) {
    return yield* failure()
  }
  return SyntheticCanaryResult.make({
    bytes: actual.byteLength,
    firstByteMs: firstByteAt - startedAt,
    requestCount,
    status: response.status,
    totalMs: completedAt - startedAt
  })
})

const Environment = Schema.Struct({
  CODEX_ROUTER_ADMIN_TOKEN: Schema.String.check(Schema.isNonEmpty()),
  CODEX_ROUTER_URL: Schema.String.check(Schema.isNonEmpty())
})

const main = Effect.gen(function* () {
  const environment = yield* Schema.decodeUnknownEffect(Environment)(process.env).pipe(
    Effect.mapError(failure)
  )
  return yield* runSyntheticCanary({
    adminToken: Redacted.make(environment.CODEX_ROUTER_ADMIN_TOKEN),
    url: environment.CODEX_ROUTER_URL
  })
})

if (import.meta.main) {
  Effect.runPromise(main).then(
    (result) => console.log(JSON.stringify(result)),
    () => {
      console.error("Synthetic streaming canary failed")
      process.exitCode = 1
    }
  )
}
