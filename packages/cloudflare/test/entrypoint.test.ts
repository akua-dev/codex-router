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
})
