import { originalWebRequest, secureCompare } from "@akua-dev/codex-router-codex"
import { Crypto, Effect, Layer, Redacted, Result, Stream } from "effect"
import { HttpEffect, HttpRouter, HttpServerResponse } from "effect/unstable/http"

export interface CodexEgressRelayOptions {
  readonly token: Redacted.Redacted<string>
  readonly fetch?: (request: Request) => Promise<Response>
}

export type CodexEgressRelay = (request: Request) => Promise<Response>

interface StreamingRequestInit extends RequestInit {
  readonly duplex: "half"
}

const concatenate = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.byteLength
  }
  return output
}

export const syntheticCanaryStream = (): Stream.Stream<Uint8Array> => {
  const encoder = new TextEncoder()
  const prefix = encoder.encode('data: {"delta":"')
  const wave = encoder.encode("🌊")
  const suffix = encoder.encode('"}\n\ndata: {"delta":"done"}\n\n')
  const done = encoder.encode("data: [DONE]\n\n")
  return Stream.make(concatenate(prefix, wave.slice(0, 2))).pipe(
    Stream.concat(
      Stream.fromEffect(
        Effect.sleep("50 millis").pipe(Effect.as(concatenate(wave.slice(2), suffix)))
      )
    ),
    Stream.concat(Stream.fromEffect(Effect.sleep("50 millis").pipe(Effect.as(done))))
  )
}

const syntheticCanaryResponse = (): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.stream(syntheticCanaryStream(), {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/octet-stream",
      "x-codex-canary": "synthetic",
      "x-codex-upstream-content-type": "text/event-stream"
    }
  })

const upstreamTarget = (request: Request): string | undefined => {
  const path = new URL(request.url).pathname
  if (
    request.method === "GET" &&
    (path === "/backend-api/wham/usage" || path === "/v1/backend-api/wham/usage")
  ) {
    return "https://chatgpt.com/backend-api/wham/usage"
  }
  if (
    request.method === "POST" &&
    (path === "/backend-api/codex/responses" || path === "/v1/backend-api/codex/responses")
  ) {
    return "https://chatgpt.com/backend-api/codex/responses"
  }
  return undefined
}

const upstreamHeaders = (input: Headers): Headers => {
  const headers = new Headers(input)
  for (const name of Array.from(headers.keys())) {
    if (
      name === "connection" ||
      name === "content-length" ||
      name === "host" ||
      name === "x-api-key" ||
      name === "x-forwarded-for" ||
      name === "x-forwarded-host" ||
      name === "x-forwarded-proto" ||
      name === "x-real-ip" ||
      name.startsWith("cf-")
    ) {
      headers.delete(name)
    }
  }
  headers.set("accept-encoding", "identity")
  return headers
}

const downstreamHeaders = (input: Headers): Headers => {
  const headers = new Headers(input)
  for (const name of [
    "connection",
    "content-encoding",
    "content-length",
    "nel",
    "proxy-authenticate",
    "report-to",
    "server",
    "set-cookie",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade"
  ]) {
    headers.delete(name)
  }
  headers.delete("x-codex-upstream-content-type")
  if (headers.get("content-type")?.toLowerCase().includes("text/event-stream") === true) {
    headers.set("content-type", "application/octet-stream")
    headers.set("x-codex-upstream-content-type", "text/event-stream")
  }
  return headers
}

const jsonError = (status: number, error: string): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe({ error }, { status })

export const makeCodexEgressRelayHttpHandler = Effect.fn("makeCodexEgressRelayHttpHandler")(
  function* (options: CodexEgressRelayOptions) {
    const crypto = yield* Crypto.Crypto

    const execute = Effect.fn("CodexEgressRelay.execute")(function* (request: Request) {
      if (request.method === "GET" && new URL(request.url).pathname === "/healthz") {
        return HttpServerResponse.jsonUnsafe({ status: "ok" })
      }
      const actualToken = request.headers.get("x-api-key")
      if (actualToken === null) {
        return jsonError(401, "unauthorized")
      }
      const authenticated = yield* Effect.result(
        secureCompare(actualToken, Redacted.value(options.token)).pipe(
          Effect.provideService(Crypto.Crypto, crypto)
        )
      )
      if (Result.isFailure(authenticated) || !authenticated.success) {
        return jsonError(401, "unauthorized")
      }
      const path = new URL(request.url).pathname
      if (request.method === "GET" && (path === "/synthetic/sse" || path === "/v1/synthetic/sse")) {
        return syntheticCanaryResponse()
      }
      const target = upstreamTarget(request)
      if (target === undefined) {
        yield* Effect.logWarning("codex relay rejected a route").pipe(
          Effect.annotateLogs({
            method: request.method,
            path
          })
        )
        return jsonError(404, "not_found")
      }
      const authorization = request.headers.get("authorization")
      const providerAccountId = request.headers.get("chatgpt-account-id")
      if (
        authorization?.toLowerCase().startsWith("bearer ") !== true ||
        providerAccountId === null ||
        providerAccountId.length === 0
      ) {
        return jsonError(400, "invalid_upstream_credential")
      }
      const init: StreamingRequestInit = {
        body: request.method === "POST" ? request.body : null,
        duplex: "half",
        headers: upstreamHeaders(request.headers),
        method: request.method,
        redirect: "manual",
        signal: request.signal
      }
      const upstream = yield* Effect.tryPromise({
        try: () => (options.fetch ?? fetch)(new Request(target, init)),
        catch: () => new Error("relay upstream request failed")
      })
      return HttpServerResponse.raw(
        new Response(upstream.body, {
          headers: downstreamHeaders(upstream.headers),
          status: upstream.status,
          statusText: upstream.statusText
        })
      )
    })

    return originalWebRequest.pipe(
      Effect.flatMap(execute),
      Effect.catchCause(() => Effect.succeed(jsonError(502, "upstream_unavailable")))
    )
  }
)

export const makeCodexEgressRelay = Effect.fn("makeCodexEgressRelay")(function* (
  options: CodexEgressRelayOptions
) {
  const handler = yield* makeCodexEgressRelayHttpHandler(options)
  return HttpEffect.toWebHandler(handler)
})

export const codexEgressRelayRoutes = (options: CodexEgressRelayOptions) =>
  Layer.unwrap(
    makeCodexEgressRelayHttpHandler(options).pipe(
      Effect.map((handler) => HttpRouter.add("*", "/*", handler))
    )
  )
