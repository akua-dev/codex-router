import { RoutingState } from "@akua-dev/codex-router-core"
import {
  AdminAuthenticator,
  ClientAuthenticator,
  makeAccountAdminHttpHandler,
  makeRawWebHandler,
  makeRouterHttpHandler,
  type RouterFetch,
  UpstreamTransport
} from "@akua-dev/codex-router-codex"
import { Clock, Effect, Option, Result } from "effect"
import { HttpEffect, HttpRouter, HttpServerResponse } from "effect/unstable/http"
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
  const now = yield* Clock.currentTimeMillis
  const summary = yield* Effect.result(routingState.summary(now))
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

const syntheticCanary = Effect.fn("syntheticCanary")(function* (
  request: Request,
  authenticator: AdminAuthenticator["Service"],
  transport: UpstreamTransport["Service"]
) {
  const authentication = yield* Effect.result(authenticator.authenticate(request))
  if (Result.isFailure(authentication)) {
    return Response.json({ error: "authentication_unavailable" }, { status: 500 })
  }
  if (!authentication.success) {
    return Response.json({ error: "unauthorized" }, { status: 401 })
  }
  const response = yield* Effect.result(
    transport.execute(
      new Request("https://chatgpt.com/synthetic/sse", {
        headers: { accept: "text/event-stream" },
        method: "GET",
        signal: request.signal
      })
    )
  )
  return Result.isFailure(response)
    ? Response.json({ error: "canary_unavailable" }, { status: 503 })
    : response.success
})

export const makeWorkerFetch = Effect.fn("makeWorkerFetch")(function* () {
  const routerHandler = yield* makeRouterHttpHandler()
  const adminHandler = yield* makeAccountAdminHttpHandler()
  const authenticator = yield* ClientAuthenticator
  const adminAuthenticator = yield* AdminAuthenticator
  const keyAdmin = yield* CredentialKeyAdmin
  const routingState = yield* RoutingState
  const transport = yield* UpstreamTransport
  const router = yield* HttpRouter.make

  yield* router.add("GET", "/healthz", HttpServerResponse.jsonUnsafe({ status: "ok" }))
  yield* router.add(
    "GET",
    "/status",
    makeRawWebHandler((request) => workerStatus(request, authenticator, routingState))
  )
  yield* router.add(
    "GET",
    "/admin/canary/sse",
    makeRawWebHandler((request) => syntheticCanary(request, adminAuthenticator, transport))
  )
  yield* router.add(
    "GET",
    "/admin/key-versions",
    makeRawWebHandler((request) => keyVersionResponse(request, adminAuthenticator, keyAdmin))
  )
  yield* router.add("*", "/admin/*", adminHandler)
  yield* router.add("*", "/*", routerHandler)

  return HttpEffect.toWebHandler(router.asHttpEffect())
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
