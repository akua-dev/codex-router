import {
  AccountAdmin,
  AccountAdminError,
  AccountAdminSummary,
  ProviderIdentityConflictError,
  type AccountAdminShape
} from "../../codex/src/index.ts"
import type { AccountId } from "../../core/src/index.ts"
import { Effect, Option, Redacted, Schema } from "effect"
import type { RouterStateStub } from "./config.ts"

const AccountList = Schema.Struct({
  accounts: Schema.Array(AccountAdminSummary)
})

const failure = () =>
  new AccountAdminError({
    message: "The Durable Object account administration request failed"
  })

const rpc = Effect.fn("DurableAccountAdmin.rpc")(function* (
  stub: RouterStateStub,
  internalToken: string,
  path: string,
  payload: unknown
) {
  const response = yield* Effect.tryPromise({
    try: () =>
      stub.fetch(
        new Request(`https://router-state.internal${path}`, {
          body: JSON.stringify(payload),
          headers: {
            "content-type": "application/json",
            "x-ai-router-internal-token": internalToken
          },
          method: "POST"
        })
      ),
    catch: failure
  })
  return response
})

const decodeSummary = Effect.fn("DurableAccountAdmin.decodeSummary")(function* (
  response: Response
) {
  if (!response.ok) {
    return yield* failure()
  }
  const raw = yield* Effect.tryPromise({
    try: () => response.json(),
    catch: failure
  })
  return yield* Schema.decodeUnknownEffect(AccountAdminSummary)(raw).pipe(Effect.mapError(failure))
})

export const makeDurableAccountAdmin = (
  stub: RouterStateStub,
  internalToken: string
): AccountAdminShape =>
  AccountAdmin.of({
    list: Effect.fn("DurableAccountAdmin.list")(function* () {
      const response = yield* rpc(stub, internalToken, "/admin/accounts/list", {})
      if (!response.ok) {
        return yield* failure()
      }
      const raw = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: failure
      })
      const decoded = yield* Schema.decodeUnknownEffect(AccountList)(raw).pipe(
        Effect.mapError(failure)
      )
      return decoded.accounts
    }),
    putCredential: Effect.fn("DurableAccountAdmin.putCredential")(
      function* (accountId, credential) {
        const response = yield* rpc(stub, internalToken, "/admin/accounts/credential", {
          accessToken: Redacted.value(credential.accessToken),
          accountId,
          expiresAt: credential.expiresAt,
          providerAccountId: Redacted.value(credential.providerAccountId),
          refreshToken: Redacted.value(credential.refreshToken)
        })
        if (response.status === 409) {
          return yield* new ProviderIdentityConflictError({
            message: "The authenticated provider identity does not match the managed account"
          })
        }
        return yield* decodeSummary(response)
      }
    ),
    remove: Effect.fn("DurableAccountAdmin.remove")(function* (accountId) {
      const response = yield* rpc(stub, internalToken, "/admin/accounts/remove", { accountId })
      if (response.status === 204) {
        return true
      }
      if (response.status === 404) {
        return false
      }
      return yield* failure()
    }),
    setEnabled: Effect.fn("DurableAccountAdmin.setEnabled")(function* (
      accountId: AccountId,
      enabled,
      now
    ) {
      const response = yield* rpc(stub, internalToken, "/admin/accounts/enabled", {
        accountId,
        enabled,
        now
      })
      if (response.status === 404) {
        return Option.none<AccountAdminSummary>()
      }
      return Option.some(yield* decodeSummary(response))
    })
  })
