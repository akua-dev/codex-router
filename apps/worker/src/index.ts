import {
  RouterStateObject,
  decodeWorkerBindings,
  makeCloudflareWorkerApplication,
  scheduleWorkerMaintenance,
  type CloudflareWorkerApplication
} from "@akua-dev/codex-router-cloudflare"
import { Effect } from "effect"

export { RouterStateObject }

let applicationPromise: Promise<CloudflareWorkerApplication> | undefined

interface WorkerScheduledController {}

interface WorkerExecutionContext {
  readonly waitUntil: (promise: Promise<unknown>) => void
}

const application = (environment: unknown): Promise<CloudflareWorkerApplication> => {
  if (applicationPromise === undefined) {
    applicationPromise = Effect.runPromise(decodeWorkerBindings(environment)).then(
      makeCloudflareWorkerApplication
    )
  }
  return applicationPromise
}

export default {
  async fetch(request: Request, environment: unknown): Promise<Response> {
    try {
      const worker = await application(environment)
      return await worker.fetch(request)
    } catch {
      return Response.json({ error: "worker_initialization_failed" }, { status: 500 })
    }
  },
  scheduled(
    _controller: WorkerScheduledController,
    environment: unknown,
    context: WorkerExecutionContext
  ): void {
    scheduleWorkerMaintenance(application(environment), Date.now(), context)
  }
}
