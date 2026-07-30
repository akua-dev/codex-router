import { SubscriptionCredential, type CredentialGeneration } from "@akua-dev/codex-router-codex"
import type { AccountId } from "@akua-dev/codex-router-core"
import { Effect, Redacted, Schema } from "effect"

const CredentialBundle = Schema.Struct({
  accessToken: Schema.String.check(Schema.isNonEmpty()),
  expiresAt: Schema.Number.check(Schema.isGreaterThan(0)),
  providerAccountId: Schema.String.check(Schema.isNonEmpty()),
  refreshToken: Schema.String.check(Schema.isNonEmpty())
})

const decodeBundle = Schema.decodeUnknownEffect(Schema.fromJsonString(CredentialBundle))

export const encodeCredentialBundle = (
  credential: SubscriptionCredential
): Redacted.Redacted<string> =>
  Redacted.make(
    JSON.stringify({
      accessToken: Redacted.value(credential.accessToken),
      expiresAt: credential.expiresAt,
      providerAccountId: Redacted.value(credential.providerAccountId),
      refreshToken: Redacted.value(credential.refreshToken)
    })
  )

export const decodeCredentialBundle = Effect.fn("decodeCredentialBundle")(function* (
  accountId: AccountId,
  generation: CredentialGeneration,
  plaintext: Redacted.Redacted<string>
) {
  const bundle = yield* decodeBundle(Redacted.value(plaintext))
  return SubscriptionCredential.make({
    accessToken: Redacted.make(bundle.accessToken),
    accountId,
    expiresAt: bundle.expiresAt,
    generation,
    providerAccountId: Redacted.make(bundle.providerAccountId),
    refreshToken: Redacted.make(bundle.refreshToken)
  })
})
