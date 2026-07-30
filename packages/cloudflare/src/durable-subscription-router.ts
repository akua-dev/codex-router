import {
  MaintenanceResult,
  SubscriptionRouteGrant,
  SubscriptionRouter,
  SubscriptionRouterError,
  type SubscriptionRouterShape
} from "@akua-dev/codex-router-codex"
import {
  AccountId,
  LeaseToken,
  RouteLease,
  type UpstreamResponseClassification
} from "@akua-dev/codex-router-core"
import { Effect, Layer, Option, Schema } from "effect"
import type { RouterStateStub } from "./config.ts"
import {
  CredentialCipherError,
  EncryptedCredentialEnvelope,
  type CredentialCipherShape
} from "./credential-cipher.ts"
import { decodeCredentialBundle } from "./credential-bundle.ts"

const FusedGrant = Schema.Struct({
  accountId: Schema.String,
  credential: Schema.Struct({
    ciphertext: Schema.String,
    generation: Schema.Int.check(Schema.isGreaterThan(0)),
    keyVersion: Schema.String,
    nonce: Schema.String
  }),
  expiresAt: Schema.Number,
  leaseToken: Schema.String
})

const BooleanResponse = Schema.Struct({
  ok: Schema.optionalKey(Schema.Boolean),
  renewed: Schema.optionalKey(Schema.Boolean)
})

const MaintenanceResponse = Schema.Struct({
  ready: Schema.Natural,
  visited: Schema.Natural
})

const rpcFailure = () =>
  new SubscriptionRouterError({
    message: "The Durable Object subscription coordinator request failed"
  })

const rpc = Effect.fn("DurableSubscriptionRouter.rpc")(function* (
  stub: RouterStateStub,
  path: string,
  payload: unknown,
  internalToken?: string
) {
  const response = yield* Effect.tryPromise({
    try: () =>
      stub.fetch(
        new Request(`https://router-state.internal${path}`, {
          body: JSON.stringify(payload),
          headers: {
            "content-type": "application/json",
            ...(internalToken === undefined ? {} : { "x-ai-router-internal-token": internalToken })
          },
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

const classificationPayload = (
  classification: UpstreamResponseClassification
): {
  readonly kind: UpstreamResponseClassification["kind"]
  readonly retryAt: number | null
} => ({
  kind: classification.kind,
  retryAt: Option.getOrNull(classification.retryAt)
})

export const makeDurableSubscriptionRouter = (
  stub: RouterStateStub,
  cipher: CredentialCipherShape,
  internalToken: string
): SubscriptionRouterShape =>
  SubscriptionRouter.of({
    acquire: Effect.fn("DurableSubscriptionRouter.acquire")(function* (input) {
      const raw = yield* rpc(stub, "/route/acquire", input)
      if (raw === null) {
        return Option.none<SubscriptionRouteGrant>()
      }
      const grant = yield* Schema.decodeUnknownEffect(FusedGrant)(raw).pipe(
        Effect.mapError(rpcFailure)
      )
      const accountId = AccountId.make(grant.accountId)
      const envelope = EncryptedCredentialEnvelope.make({
        ciphertext: grant.credential.ciphertext,
        keyVersion: grant.credential.keyVersion,
        nonce: grant.credential.nonce
      })
      const plaintext = yield* cipher
        .decrypt(accountId, grant.credential.generation, envelope)
        .pipe(
          Effect.mapError(
            () =>
              new CredentialCipherError({
                message: "The selected credential could not be decrypted"
              })
          ),
          Effect.mapError(rpcFailure)
        )
      const credential = yield* decodeCredentialBundle(
        accountId,
        grant.credential.generation,
        plaintext
      ).pipe(Effect.mapError(rpcFailure))
      return Option.some(
        SubscriptionRouteGrant.make({
          credential,
          lease: RouteLease.make({
            accountId,
            expiresAt: grant.expiresAt,
            leaseToken: LeaseToken.make(grant.leaseToken),
            sessionKey:
              input.sessionKey === undefined ? Option.none() : Option.some(input.sessionKey)
          })
        })
      )
    }),
    maintain: Effect.fn("DurableSubscriptionRouter.maintain")(function* (now) {
      const raw = yield* rpc(stub, "/maintenance/sweep", { now }, internalToken)
      const result = yield* Schema.decodeUnknownEffect(MaintenanceResponse)(raw).pipe(
        Effect.mapError(rpcFailure)
      )
      return MaintenanceResult.make(result)
    }),
    recordResponse: Effect.fn("DurableSubscriptionRouter.recordResponse")(
      function* (accountId, generation, classification, now) {
        const raw = yield* rpc(stub, "/route/record-response", {
          accountId,
          generation,
          now,
          ...classificationPayload(classification)
        })
        yield* Schema.decodeUnknownEffect(BooleanResponse)(raw).pipe(Effect.mapError(rpcFailure))
      }
    ),
    release: Effect.fn("DurableSubscriptionRouter.release")(function* (leaseToken) {
      const raw = yield* rpc(stub, "/route/release", { leaseToken })
      yield* Schema.decodeUnknownEffect(BooleanResponse)(raw).pipe(Effect.mapError(rpcFailure))
    }),
    renew: Effect.fn("DurableSubscriptionRouter.renew")(function* (leaseToken, now) {
      const raw = yield* rpc(stub, "/route/renew", { leaseToken, now })
      const result = yield* Schema.decodeUnknownEffect(BooleanResponse)(raw).pipe(
        Effect.mapError(rpcFailure)
      )
      return result.renewed === true
    })
  })

export const durableSubscriptionRouterLayer = (
  stub: RouterStateStub,
  cipher: CredentialCipherShape,
  internalToken: string
) => Layer.succeed(SubscriptionRouter, makeDurableSubscriptionRouter(stub, cipher, internalToken))
