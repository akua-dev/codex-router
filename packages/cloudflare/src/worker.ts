import { RoutingState } from "@akua-dev/codex-router-core"
import {
  AdminAuthenticator,
  ClientAuthenticator,
  makeAccountAdminFetch,
  makeRouterFetch,
  type RouterFetch
} from "@akua-dev/codex-router-codex"
import { Effect, Option, Result } from "effect"
import { CredentialKeyAdmin } from "./credential-key-admin.ts"

const keyVersionResponse = Effect.fn("keyVersionResponse")(function* (
  request: Request,
  authenticator: AdminAuthenticator["Service"],
  keyAdmin: CredentialKeyAdmin["Service"]
) {
  const authentication = yield* Effect.result(authenticator.authenticate(request))
  if (Result.isFailure(authentication)) {
    return Response.json({ error: "authentication_unavailable" }, { status: 500 })
  }
  if (!authentication.success) {
    return Response.json({ error: "unauthorized" }, { status: 401 })
  }
  const versions = yield* Effect.result(keyAdmin.counts())
  return Result.isFailure(versions)
    ? Response.json({ error: "credential_keys_unavailable" }, { status: 503 })
    : Response.json({ versions: versions.success })
})

const workerStatus = Effect.fn("workerStatus")(function* (
  request: Request,
  authenticator: ClientAuthenticator["Service"],
  routingState: RoutingState["Service"]
) {
  const authentication = yield* Effect.result(authenticator.authenticate(request))
  if (Result.isFailure(authentication) || !authentication.success) {
    return Response.json({ error: "unauthorized" }, { status: 401 })
  }
  const summary = yield* Effect.result(routingState.summary(Date.now()))
  if (Result.isFailure(summary)) {
    return Response.json({ error: "routing_state_unavailable" }, { status: 503 })
  }
  return Response.json({
    accounts: summary.success.accounts.map((account) => ({
      accountId: account.accountId,
      activeReservations: account.activeReservations,
      blockKind: Option.getOrNull(account.blockKind),
      requiresReauthentication: account.requiresReauthentication
    })),
    activeReservations: summary.success.activeReservations,
    assignments: summary.success.assignments
  })
})

export const makeWorkerFetch = Effect.fn("makeWorkerFetch")(function* () {
  const routerFetch = yield* makeRouterFetch()
  const adminFetch = yield* makeAccountAdminFetch()
  const authenticator = yield* ClientAuthenticator
  const adminAuthenticator = yield* AdminAuthenticator
  const keyAdmin = yield* CredentialKeyAdmin
  const routingState = yield* RoutingState

  return (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname
    if (path === "/healthz" && request.method === "GET") {
      return Promise.resolve(Response.json({ status: "ok" }))
    }
    if (path === "/status" && request.method === "GET") {
      return Effect.runPromise(workerStatus(request, authenticator, routingState))
    }
    if (path === "/admin/key-versions" && request.method === "GET") {
      return Effect.runPromise(keyVersionResponse(request, adminAuthenticator, keyAdmin))
    }
    if (path.startsWith("/admin/")) {
      return adminFetch(request)
    }
    return routerFetch(request)
  }
})

export interface CloudflareWorkerApplication {
  readonly fetch: RouterFetch
  readonly maintain: (now: number) => Promise<unknown>
  readonly close: () => Promise<void>
}

export interface WorkerExecutionContext {
  readonly waitUntil: (promise: Promise<unknown>) => void
}

export const scheduleWorkerMaintenance = (
  application: Promise<CloudflareWorkerApplication>,
  now: number,
  context: WorkerExecutionContext
): void => {
  context.waitUntil(application.then((worker) => worker.maintain(now)).then(() => undefined))
}
