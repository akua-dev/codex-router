import { type CloudflareWorkerApplication, type WorkerExecutionContext } from "./worker.ts"
import { Clock, Effect } from "effect"

export interface WorkerScheduledController {}

export interface CloudflareWorkerEntrypoint {
  readonly fetch: (
    request: Request,
    environment: unknown,
    context: WorkerExecutionContext
  ) => Promise<Response>
  readonly scheduled: (
    controller: WorkerScheduledController,
    environment: unknown,
    context: WorkerExecutionContext
  ) => void
}

export type WorkerApplicationFactory = (
  environment: unknown
) => Promise<CloudflareWorkerApplication>

const closeIgnoringFailure = async (application: CloudflareWorkerApplication): Promise<void> => {
  try {
    await application.close()
  } catch {
    // A cleanup failure must not replace an already-produced response.
  }
}

const responseWithApplicationLifetime = (
  response: Response,
  application: CloudflareWorkerApplication
): Promise<Response> => {
  if (response.body === null) {
    return closeIgnoringFailure(application).then(() => response)
  }
  const reader = response.body.getReader()
  let closePromise: Promise<void> | undefined
  const close = (): Promise<void> => {
    closePromise ??= closeIgnoringFailure(application)
    return closePromise
  }
  const body = new ReadableStream<Uint8Array>({
    async cancel(reason) {
      try {
        await reader.cancel(reason)
      } finally {
        await close()
      }
    },
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) {
          await close()
          controller.close()
        } else {
          controller.enqueue(next.value)
        }
      } catch (error) {
        await close()
        controller.error(error)
      }
    }
  })
  return Promise.resolve(
    new Response(body, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText
    })
  )
}

export const makeWorkerEntrypoint = (
  applicationFactory: WorkerApplicationFactory
): CloudflareWorkerEntrypoint => ({
  async fetch(request, environment) {
    const path = new URL(request.url).pathname
    if (path === "/healthz" && request.method === "GET") {
      return Response.json({ status: "ok" })
    }
    let application: CloudflareWorkerApplication
    try {
      application = await applicationFactory(environment)
    } catch {
      return Response.json({ error: "worker_initialization_failed" }, { status: 500 })
    }
    try {
      const response = await application.fetch(request)
      return await responseWithApplicationLifetime(response, application)
    } catch {
      await closeIgnoringFailure(application)
      return Response.json({ error: "worker_request_failed" }, { status: 500 })
    }
  },
  scheduled(_controller, environment, context) {
    const maintenance = Promise.all([
      applicationFactory(environment),
      Effect.runPromise(Clock.currentTimeMillis)
    ]).then(async ([application, now]) => {
      try {
        await application.maintain(now)
      } finally {
        await closeIgnoringFailure(application)
      }
    })
    context.waitUntil(maintenance)
  }
})
