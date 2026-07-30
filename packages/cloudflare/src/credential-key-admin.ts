import { Context, Effect, Schema } from "effect"
import type { RouterStateStub } from "./config.ts"

export class CredentialKeyVersionCount extends Schema.Class<CredentialKeyVersionCount>(
  "CredentialKeyVersionCount"
)({
  count: Schema.Natural,
  keyVersion: Schema.String
}) {}

const KeyVersionResponse = Schema.Struct({
  versions: Schema.Array(CredentialKeyVersionCount)
})

export class CredentialKeyAdminError extends Schema.TaggedErrorClass<CredentialKeyAdminError>()(
  "CredentialKeyAdminError",
  {
    message: Schema.String
  }
) {}

export class CredentialKeyAdmin extends Context.Service<
  CredentialKeyAdmin,
  {
    readonly counts: () => Effect.Effect<
      ReadonlyArray<CredentialKeyVersionCount>,
      CredentialKeyAdminError
    >
  }
>()("@akua-dev/codex-router/CredentialKeyAdmin") {}

const failure = () =>
  new CredentialKeyAdminError({
    message: "Credential key-version counts are unavailable"
  })

export const makeDurableCredentialKeyAdmin = (
  stub: RouterStateStub,
  internalToken: string
): CredentialKeyAdmin["Service"] =>
  CredentialKeyAdmin.of({
    counts: Effect.fn("CredentialKeyAdmin.counts")(function* () {
      const response = yield* Effect.tryPromise({
        try: () =>
          stub.fetch(
            new Request("https://router-state.internal/admin/key-versions", {
              body: "{}",
              headers: {
                "content-type": "application/json",
                "x-ai-router-internal-token": internalToken
              },
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
      const decoded = yield* Schema.decodeUnknownEffect(KeyVersionResponse)(raw).pipe(
        Effect.mapError(failure)
      )
      return decoded.versions
    })
  })
