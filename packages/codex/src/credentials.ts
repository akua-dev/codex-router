import { AccountId } from "@akua-dev/codex-router-core"
import { Effect, Redacted, Schema } from "effect"

export const CredentialGeneration = Schema.Int.check(Schema.isGreaterThan(0))
export type CredentialGeneration = typeof CredentialGeneration.Type

export class InvalidCodexTokenError extends Schema.TaggedErrorClass<InvalidCodexTokenError>()(
  "InvalidCodexTokenError",
  {
    message: Schema.String
  }
) {}

export class SubscriptionCredential extends Schema.Class<SubscriptionCredential>(
  "SubscriptionCredential"
)({
  accessToken: Schema.Redacted(Schema.String),
  accountId: AccountId,
  expiresAt: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  generation: CredentialGeneration,
  providerAccountId: Schema.Redacted(Schema.String),
  refreshToken: Schema.Redacted(Schema.String)
}) {
  get authorization(): string {
    return `Bearer ${Redacted.value(this.accessToken)}`
  }
}

const JwtPayload = Schema.Struct({
  "https://api.openai.com/auth": Schema.Struct({
    chatgpt_account_id: Schema.String.check(Schema.isNonEmpty())
  })
})

const decodeJwtPayload = Schema.decodeUnknownEffect(JwtPayload)

const tokenFailure = () =>
  new InvalidCodexTokenError({
    message: "The Codex access token does not contain a usable account identity"
  })

const decodeBase64Url = (value: string): Uint8Array => {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/")
  const padding = "=".repeat((4 - (base64.length % 4)) % 4)
  const binary = atob(base64 + padding)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

export const extractProviderAccountId = Effect.fn("extractProviderAccountId")(function* (
  accessToken: string
) {
  const payload = yield* Effect.try({
    try: () => {
      const parts = accessToken.split(".")
      if (parts.length !== 3 || parts[1] === undefined) {
        throw tokenFailure()
      }
      return JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[1])))
    },
    catch: tokenFailure
  })
  const decoded = yield* decodeJwtPayload(payload).pipe(Effect.mapError(tokenFailure))
  return Redacted.make(decoded["https://api.openai.com/auth"].chatgpt_account_id)
})
