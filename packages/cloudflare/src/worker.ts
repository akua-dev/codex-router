import { RoutingState } from "@akua-dev/codex-router-core"
import {
  ClientAuthenticator,
  makeRouterFetch,
  type RouterFetch
} from "@akua-dev/codex-router-codex"
import { Effect, Option, Result } from "effect"

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
  const authenticator = yield* ClientAuthenticator
  const routingState = yield* RoutingState

  return (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname
    if (path === "/healthz" && request.method === "GET") {
      return Promise.resolve(Response.json({ status: "ok" }))
    }
    if (path === "/status" && request.method === "GET") {
      return Effect.runPromise(workerStatus(request, authenticator, routingState))
    }
    return routerFetch(request)
  }
})

export interface CloudflareWorkerApplication {
  readonly fetch: RouterFetch
  readonly close: () => Promise<void>
}
