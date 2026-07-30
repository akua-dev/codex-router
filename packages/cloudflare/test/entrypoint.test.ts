import { describe, expect, it } from "@effect/vitest"
import { makeWorkerEntrypoint, type CloudflareWorkerApplication } from "../src/index.ts"

describe("Cloudflare Worker entrypoint lifecycle", () => {
  it("uses request-scoped applications and closes them after each response stream", async () => {
    let applications = 0
    let closes = 0
    let maintenanceRuns = 0
    const entrypoint = makeWorkerEntrypoint(async () => {
      applications += 1
      const applicationId = applications
      return {
        close: async () => {
          closes += 1
        },
        fetch: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(`application-${applicationId}`))
                controller.close()
              }
            })
          ),
        maintain: async () => {
          maintenanceRuns += 1
        }
      } satisfies CloudflareWorkerApplication
    })

    const firstHealth = await entrypoint.fetch(
      new Request("https://worker.invalid/healthz"),
      {},
      { waitUntil: () => undefined }
    )
    const secondHealth = await entrypoint.fetch(
      new Request("https://worker.invalid/healthz"),
      {},
      { waitUntil: () => undefined }
    )
    const first = await entrypoint.fetch(
      new Request("https://worker.invalid/status"),
      {},
      { waitUntil: () => undefined }
    )
    const second = await entrypoint.fetch(
      new Request("https://worker.invalid/status"),
      {},
      { waitUntil: () => undefined }
    )

    expect(await firstHealth.json()).toEqual({ status: "ok" })
    expect(await secondHealth.json()).toEqual({ status: "ok" })
    expect(await first.text()).toBe("application-1")
    expect(await second.text()).toBe("application-2")
    expect(applications).toBe(2)
    expect(closes).toBe(2)

    let scheduled: Promise<unknown> | undefined
    entrypoint.scheduled(
      {},
      {},
      {
        waitUntil(promise) {
          scheduled = promise
        }
      }
    )
    await scheduled

    expect(applications).toBe(3)
    expect(maintenanceRuns).toBe(1)
    expect(closes).toBe(3)
  })

  it("closes request applications after empty, cancelled, errored, and rejected responses", async () => {
    let closes = 0
    const application = (
      fetch: CloudflareWorkerApplication["fetch"]
    ): CloudflareWorkerApplication => ({
      close: async () => {
        closes += 1
      },
      fetch,
      maintain: async () => undefined
    })
    const context = { waitUntil: () => undefined }

    const empty = makeWorkerEntrypoint(async () =>
      application(async () => new Response(null, { status: 204 }))
    )
    expect(
      (await empty.fetch(new Request("https://worker.invalid/status"), {}, context)).status
    ).toBe(204)
    expect(closes).toBe(1)

    const cancelled = makeWorkerEntrypoint(async () =>
      application(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull() {
                // Remain open until the downstream cancels.
              }
            })
          )
      )
    )
    const cancelledResponse = await cancelled.fetch(
      new Request("https://worker.invalid/status"),
      {},
      context
    )
    await cancelledResponse.body?.cancel("cancelled")
    expect(closes).toBe(2)

    const errored = makeWorkerEntrypoint(async () =>
      application(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                controller.error(new Error("stream failed"))
              }
            })
          )
      )
    )
    const erroredResponse = await errored.fetch(
      new Request("https://worker.invalid/status"),
      {},
      context
    )
    await expect(erroredResponse.body?.getReader().read()).rejects.toThrow("stream failed")
    expect(closes).toBe(3)

    const rejected = makeWorkerEntrypoint(async () =>
      application(async () => {
        throw new Error("handler failed")
      })
    )
    expect(
      (await rejected.fetch(new Request("https://worker.invalid/status"), {}, context)).status
    ).toBe(500)
    expect(closes).toBe(4)
  })
})
