import { describe, expect, it } from "@effect/vitest"
import { scheduleWorkerMaintenance, type CloudflareWorkerApplication } from "../src/index.ts"

describe("Worker scheduled maintenance", () => {
  it("passes one maintenance promise to waitUntil", async () => {
    const observed: Array<number> = []
    let scheduled: Promise<unknown> | undefined
    const application: CloudflareWorkerApplication = {
      close: () => Promise.resolve(),
      fetch: () => Promise.resolve(new Response()),
      maintain: (now) => {
        observed.push(now)
        return Promise.resolve({ ready: 1, visited: 1 })
      }
    }

    scheduleWorkerMaintenance(Promise.resolve(application), 123_456, {
      waitUntil: (promise) => {
        scheduled = promise
      }
    })

    expect(scheduled).toBeDefined()
    await scheduled
    expect(observed).toEqual([123_456])
  })
})
