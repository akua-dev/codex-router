import {
  CodexControlTransport,
  CodexControlTransportError,
  makeHttpClientCodexControlTransport,
  type CodexControlTransportShape
} from "../../codex/src/index.ts"
import { Effect, Redacted } from "effect"
import { HttpClient } from "effect/unstable/http"
import type { WorkerRuntimeConfig } from "./config.ts"

const failure = () =>
  new CodexControlTransportError({
    message: "The Cloudflare Codex control-plane request did not complete"
  })

const gatewayUrl = (request: Request, config: WorkerRuntimeConfig): URL => {
  const source = new URL(request.url)
  const root =
    `https://gateway.ai.cloudflare.com/v1/` +
    `${encodeURIComponent(config.aiGatewayAccountId)}/` +
    `${encodeURIComponent(config.aiGatewayGatewayId)}/` +
    `custom-${encodeURIComponent(config.aiGatewayCustomProviderSlug)}`
  return new URL(`${root}${source.pathname}${source.search}`)
}

export const makeCloudflareCodexControlTransport = (
  config: WorkerRuntimeConfig,
  client: HttpClient.HttpClient
): CodexControlTransportShape => {
  const transport = makeHttpClientCodexControlTransport(client)
  return CodexControlTransport.of({
    execute: Effect.fn("CloudflareCodexControlTransport.execute")(function* (request) {
      const source = new URL(request.url)
      if (source.hostname === "auth.openai.com") {
        return yield* transport.execute(request).pipe(Effect.mapError(failure))
      }
      if (source.hostname !== "chatgpt.com") {
        return yield* failure()
      }
      const headers = new Headers(request.headers)
      headers.set("cf-aig-authorization", `Bearer ${Redacted.value(config.aiGatewayRunToken)}`)
      headers.set("cf-aig-skip-cache", "true")
      headers.set("cf-aig-collect-log-payload", "false")
      headers.set("cf-aig-max-attempts", "1")
      headers.set("x-api-key", Redacted.value(config.relayToken))
      headers.set(
        "cf-aig-metadata",
        JSON.stringify({ operation: "subscription_usage", runtime: "cloudflare_do" })
      )
      const forwarded = new Request(gatewayUrl(request, config), {
        headers,
        method: request.method,
        signal: request.signal
      })
      return yield* transport.execute(forwarded).pipe(Effect.mapError(failure))
    })
  })
}
