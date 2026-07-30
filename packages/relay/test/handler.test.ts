import { describe, expect, it } from "@effect/vitest"
import { Redacted } from "effect"
import { makeCodexEgressRelay } from "../src/index.ts"

describe("Codex egress relay", () => {
  it("exposes only a public liveness response", async () => {
    let upstreamCalls = 0
    const relay = makeCodexEgressRelay({
      fetch: async () => {
        upstreamCalls += 1
        return new Response()
      },
      token: Redacted.make("relay-secret")
    })

    const response = await relay(new Request("https://relay.invalid/healthz"))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: "ok" })
    expect(upstreamCalls).toBe(0)
  })

  it("authenticates before reading the request body", async () => {
    let bodyPulled = false
    let upstreamCalls = 0
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          bodyPulled = true
          controller.enqueue(new TextEncoder().encode("sensitive"))
          controller.close()
        }
      },
      { highWaterMark: 0 }
    )
    const relay = makeCodexEgressRelay({
      fetch: async () => {
        upstreamCalls += 1
        return new Response()
      },
      token: Redacted.make("relay-secret")
    })

    const response = await relay(
      new Request("https://relay.invalid/backend-api/codex/responses", {
        body,
        duplex: "half",
        method: "POST"
      } as RequestInit & { readonly duplex: "half" })
    )

    expect(response.status).toBe(401)
    expect(bodyPulled).toBe(false)
    expect(upstreamCalls).toBe(0)
  })

  it("forwards one opaque request and preserves streaming response bytes", async () => {
    const expected = new TextEncoder().encode('data: {"delta":"🌊"}\n\ndata: [DONE]\n\n')
    const first = expected.slice(0, 19)
    const second = expected.slice(19, 23)
    const third = expected.slice(23)
    let upstreamCalls = 0
    let upstreamRequest: Request | undefined
    const relay = makeCodexEgressRelay({
      fetch: async (request) => {
        upstreamCalls += 1
        upstreamRequest = request
        return new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(first)
              await new Promise((resolve) => setTimeout(resolve, 5))
              controller.enqueue(second)
              controller.enqueue(third)
              controller.close()
            }
          }),
          {
            headers: {
              "content-type": "text/event-stream",
              "set-cookie": "must-not-leave-relay=1"
            },
            status: 200
          }
        )
      },
      token: Redacted.make("relay-secret")
    })

    const response = await relay(
      new Request("https://relay.invalid/backend-api/codex/responses", {
        body: '{"input":"opaque"}',
        headers: {
          authorization: "Bearer subscription-secret",
          "chatgpt-account-id": "provider-account",
          "content-type": "application/json",
          "x-api-key": "relay-secret"
        },
        method: "POST"
      })
    )
    const reader = response.body?.getReader()
    expect(reader).toBeDefined()
    if (reader === undefined) {
      return
    }
    const chunks: Array<Uint8Array> = []
    while (true) {
      const next = await reader.read()
      if (next.done) {
        break
      }
      chunks.push(next.value)
    }
    const actual = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
    let offset = 0
    for (const chunk of chunks) {
      actual.set(chunk, offset)
      offset += chunk.byteLength
    }

    expect(upstreamCalls).toBe(1)
    expect(upstreamRequest?.url).toBe("https://chatgpt.com/backend-api/codex/responses")
    expect(upstreamRequest?.headers.get("authorization")).toBe("Bearer subscription-secret")
    expect(upstreamRequest?.headers.get("chatgpt-account-id")).toBe("provider-account")
    expect(upstreamRequest?.headers.has("x-api-key")).toBe(false)
    expect(response.headers.has("set-cookie")).toBe(false)
    expect(response.headers.get("content-type")).toBe("application/octet-stream")
    expect(response.headers.get("x-codex-upstream-content-type")).toBe("text/event-stream")
    expect(actual).toEqual(expected)
  })

  it("allows only the Codex response and quota endpoints", async () => {
    let upstreamCalls = 0
    const relay = makeCodexEgressRelay({
      fetch: async () => {
        upstreamCalls += 1
        return new Response()
      },
      token: Redacted.make("relay-secret")
    })

    const response = await relay(
      new Request("https://relay.invalid/backend-api/other", {
        headers: { "x-api-key": "relay-secret" }
      })
    )

    expect(response.status).toBe(404)
    expect(upstreamCalls).toBe(0)
  })

  it("accepts AI Gateway's v1-prefixed quota path without widening the proxy", async () => {
    let upstreamUrl: string | undefined
    const relay = makeCodexEgressRelay({
      fetch: async (request) => {
        upstreamUrl = request.url
        return Response.json({ plan_type: "pro" })
      },
      token: Redacted.make("relay-secret")
    })

    const response = await relay(
      new Request("https://relay.invalid/v1/backend-api/wham/usage", {
        headers: {
          authorization: "Bearer subscription-secret",
          "chatgpt-account-id": "provider-account",
          "x-api-key": "relay-secret"
        }
      })
    )

    expect(response.status).toBe(200)
    expect(upstreamUrl).toBe("https://chatgpt.com/backend-api/wham/usage")
  })

  it("emits a delayed byte-sensitive synthetic SSE fixture without an upstream call", async () => {
    let upstreamCalls = 0
    const relay = makeCodexEgressRelay({
      fetch: async () => {
        upstreamCalls += 1
        return new Response()
      },
      token: Redacted.make("relay-secret")
    })
    const expected = new TextEncoder().encode(
      'data: {"delta":"🌊"}\n\ndata: {"delta":"done"}\n\ndata: [DONE]\n\n'
    )
    const startedAt = performance.now()

    const response = await relay(
      new Request("https://relay.invalid/v1/synthetic/sse", {
        headers: { "x-api-key": "relay-secret" }
      })
    )
    const actual = new Uint8Array(await response.arrayBuffer())
    const completedAt = performance.now()

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/octet-stream")
    expect(response.headers.get("x-codex-upstream-content-type")).toBe("text/event-stream")
    expect(response.headers.get("x-codex-canary")).toBe("synthetic")
    expect(actual).toEqual(expected)
    expect(completedAt - startedAt).toBeGreaterThanOrEqual(80)
    expect(upstreamCalls).toBe(0)
  })
})
