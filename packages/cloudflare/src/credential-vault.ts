import type { AccountId } from "@akua-dev/codex-router-core"
import { Effect, Redacted, Schema } from "effect"
import type { RouterStateStub } from "./config.ts"
import { EncryptedCredentialEnvelope, type CredentialCipherShape } from "./credential-cipher.ts"

export class CredentialVaultError extends Schema.TaggedErrorClass<CredentialVaultError>()(
  "CredentialVaultError",
  {
    message: Schema.String
  }
) {}

export interface CredentialVault {
  readonly put: (
    accountId: AccountId,
    credential: Redacted.Redacted<string>
  ) => Effect.Effect<void, CredentialVaultError>
  readonly get: (
    accountId: AccountId
  ) => Effect.Effect<Redacted.Redacted<string>, CredentialVaultError>
}

const failure = () =>
  new CredentialVaultError({
    message: "The encrypted credential vault operation failed"
  })

export const makeDurableCredentialVault = (
  stub: RouterStateStub,
  cipher: CredentialCipherShape
): CredentialVault => ({
  put: Effect.fn("CredentialVault.put")(function* (accountId, credential) {
    const envelope = yield* cipher.encrypt(accountId, credential).pipe(Effect.mapError(failure))
    const response = yield* Effect.tryPromise({
      try: () =>
        stub.fetch(
          new Request("https://router-state.internal/credential/put", {
            body: JSON.stringify({
              accountId,
              ciphertext: envelope.ciphertext,
              keyVersion: envelope.keyVersion,
              nonce: envelope.nonce
            }),
            headers: { "content-type": "application/json" },
            method: "POST"
          })
        ),
      catch: failure
    })
    if (!response.ok) {
      return yield* failure()
    }
  }),
  get: Effect.fn("CredentialVault.get")(function* (accountId) {
    const response = yield* Effect.tryPromise({
      try: () =>
        stub.fetch(
          new Request("https://router-state.internal/credential/get", {
            body: JSON.stringify({ accountId }),
            headers: { "content-type": "application/json" },
            method: "POST"
          })
        ),
      catch: failure
    })
    if (!response.ok) {
      return yield* failure()
    }
    const raw = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: failure
    })
    const envelope = yield* Schema.decodeUnknownEffect(EncryptedCredentialEnvelope)(raw).pipe(
      Effect.mapError(failure)
    )
    return yield* cipher.decrypt(accountId, envelope).pipe(Effect.mapError(failure))
  })
})
