import {
  AccountId,
  AccountRoutingSummary,
  LeaseToken,
  RouteLease,
  RoutingState,
  RoutingStateError,
  RoutingSummary,
  type AcquireRouteInput,
  type RoutingStateShape
} from "../../core/src/index.ts"
import { Effect, Layer, Option, Schema } from "effect"
import type { RouterStateStub } from "./config.ts"

const LeaseDto = Schema.Struct({
  accountId: Schema.String,
  expiresAt: Schema.Number,
  leaseToken: Schema.String
})

const BooleanResult = Schema.Struct({
  ok: Schema.optionalKey(Schema.Boolean),
  renewed: Schema.optionalKey(Schema.Boolean)
})

const AccountSummaryDto = Schema.Struct({
  accountId: Schema.String,
  activeReservations: Schema.Number,
  blockKind: Schema.NullOr(Schema.Literals(["quota", "transient"])),
  requiresReauthentication: Schema.Boolean
})

const SummaryDto = Schema.Struct({
  activeReservations: Schema.Number,
  assignments: Schema.Number,
  accounts: Schema.Array(AccountSummaryDto)
})

const rpcFailure = () =>
  new RoutingStateError({
    message: "The Durable Object routing state request failed"
  })

const rpc = Effect.fn("DurableObjectRoutingState.rpc")(function* (
  stub: RouterStateStub,
  path: string,
  payload: unknown
) {
  const response = yield* Effect.tryPromise({
    try: () =>
      stub.fetch(
        new Request(`https://router-state.internal${path}`, {
          body: JSON.stringify(payload),
          headers: { "content-type": "application/json" },
          method: "POST"
        })
      ),
    catch: rpcFailure
  })
  if (!response.ok) {
    return yield* rpcFailure()
  }
  return yield* Effect.tryPromise({
    try: () => response.json(),
    catch: rpcFailure
  })
})

export const makeDurableObjectRoutingState = (stub: RouterStateStub): RoutingStateShape =>
  RoutingState.of({
    acquire: Effect.fn("DurableObjectRoutingState.acquire")(function* (input: AcquireRouteInput) {
      const raw = yield* rpc(stub, "/acquire", {
        candidates: input.candidates,
        now: input.now,
        ...(input.sessionKey === undefined ? {} : { sessionKey: input.sessionKey })
      })
      if (raw === null) {
        return Option.none<RouteLease>()
      }
      const dto = yield* Schema.decodeUnknownEffect(LeaseDto)(raw).pipe(Effect.mapError(rpcFailure))
      return Option.some(
        RouteLease.make({
          accountId: AccountId.make(dto.accountId),
          expiresAt: dto.expiresAt,
          leaseToken: LeaseToken.make(dto.leaseToken),
          sessionKey: input.sessionKey === undefined ? Option.none() : Option.some(input.sessionKey)
        })
      )
    }),
    renew: Effect.fn("DurableObjectRoutingState.renew")(function* (leaseToken, now) {
      const raw = yield* rpc(stub, "/renew", { leaseToken, now })
      const dto = yield* Schema.decodeUnknownEffect(BooleanResult)(raw).pipe(
        Effect.mapError(rpcFailure)
      )
      return dto.renewed === true
    }),
    release: Effect.fn("DurableObjectRoutingState.release")(function* (leaseToken) {
      const raw = yield* rpc(stub, "/release", { leaseToken })
      yield* Schema.decodeUnknownEffect(BooleanResult)(raw).pipe(Effect.mapError(rpcFailure))
    }),
    recordResponse: Effect.fn("DurableObjectRoutingState.recordResponse")(
      function* (accountId, classification, now) {
        const raw = yield* rpc(stub, "/record-response", {
          accountId,
          kind: classification.kind,
          now,
          retryAt: Option.getOrNull(classification.retryAt)
        })
        yield* Schema.decodeUnknownEffect(BooleanResult)(raw).pipe(Effect.mapError(rpcFailure))
      }
    ),
    summary: Effect.fn("DurableObjectRoutingState.summary")(function* (now) {
      const raw = yield* rpc(stub, "/summary", { now })
      const dto = yield* Schema.decodeUnknownEffect(SummaryDto)(raw).pipe(
        Effect.mapError(rpcFailure)
      )
      return RoutingSummary.make({
        accounts: dto.accounts.map((account) =>
          AccountRoutingSummary.make({
            accountId: AccountId.make(account.accountId),
            activeReservations: account.activeReservations,
            blockKind: account.blockKind === null ? Option.none() : Option.some(account.blockKind),
            requiresReauthentication: account.requiresReauthentication
          })
        ),
        activeReservations: dto.activeReservations,
        assignments: dto.assignments
      })
    })
  })

export const durableObjectRoutingStateLayer = (stub: RouterStateStub) =>
  Layer.succeed(RoutingState, makeDurableObjectRoutingState(stub))
