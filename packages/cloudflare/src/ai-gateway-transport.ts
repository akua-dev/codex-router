import {
  TransportError,
  UpstreamTransport,
  type UpstreamTransport as UpstreamTransportService
} from "@akua-dev/codex-router-codex"
import { Effect, Redacted } from "effect"

export type AiGatewayMetadataValue = string | number | boolean

export interface AiGatewayTransportOptions {
  readonly accountId: string
  readonly gatewayId: string
  readonly customProviderSlug: string
  readonly runToken: Redacted.Redacted<string>
  readonly metadata?: Readonly<Record<string, AiGatewayMetadataValue>>
  readonly fetch?: (request: Request) => Promise<Response>
}

interface StreamingRequestInit extends RequestInit {
  readonly duplex: "half"
}

const validateMetadata = (
  metadata: Readonly<Record<string, AiGatewayMetadataValue>> | undefined
): string | undefined => {
  if (metadata === undefined) {
    return undefined
  }
  const entries = Object.entries(metadata)
  if (entries.length > 5 || entries.some(([key]) => key.length === 0 || key.length > 64)) {
    throw new Error("invalid AI Gateway metadata")
  }
  const encoded = JSON.stringify(metadata)
  if (encoded.length > 2_048) {
    throw new Error("AI Gateway metadata is too large")
  }
  return encoded
}

const gatewayTarget = (requestUrl: URL, options: AiGatewayTransportOptions): URL => {
  const root = `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(options.accountId)}/${encodeURIComponent(options.gatewayId)}`
  if (requestUrl.hostname === "chatgpt.com") {
    return new URL(
      `${root}/custom-${encodeURIComponent(options.customProviderSlug)}${requestUrl.pathname}${requestUrl.search}`
    )
  }
  if (requestUrl.hostname === "api.openai.com") {
    const path = requestUrl.pathname.startsWith("/v1/")
      ? requestUrl.pathname.slice(3)
      : requestUrl.pathname
    return new URL(`${root}/openai${path}${requestUrl.search}`)
  }
  throw new Error("unsupported upstream host")
}

export const makeAiGatewayTransport = (
  options: AiGatewayTransportOptions
): UpstreamTransportService["Service"] =>
  UpstreamTransport.of({
    execute: Effect.fn("AiGatewayTransport.execute")((request) =>
      Effect.tryPromise({
        try: () => {
          const metadata = validateMetadata(options.metadata)
          const headers = new Headers(request.headers)
          headers.set("cf-aig-authorization", `Bearer ${Redacted.value(options.runToken)}`)
          headers.set("cf-aig-skip-cache", "true")
          headers.set("cf-aig-collect-log-payload", "false")
          headers.set("cf-aig-max-attempts", "1")
          if (metadata === undefined) {
            headers.delete("cf-aig-metadata")
          } else {
            headers.set("cf-aig-metadata", metadata)
          }
          const init: StreamingRequestInit = {
            body: request.body,
            duplex: "half",
            headers,
            method: request.method,
            redirect: request.redirect,
            signal: request.signal
          }
          const forwarded = new Request(gatewayTarget(new URL(request.url), options), init)
          return (options.fetch ?? fetch)(forwarded)
        },
        catch: () =>
          new TransportError({
            message: "The Cloudflare AI Gateway request did not complete"
          })
      })
    )
  })
