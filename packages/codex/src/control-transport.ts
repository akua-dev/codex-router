import { Context, Effect, Schema } from "effect"

export class CodexControlTransportError extends Schema.TaggedErrorClass<CodexControlTransportError>()(
  "CodexControlTransportError",
  {
    message: Schema.String
  }
) {}

export interface CodexControlTransportShape {
  readonly execute: (
    request: Request
  ) => Effect.Effect<Response, CodexControlTransportError>
}

export class CodexControlTransport extends Context.Service<
  CodexControlTransport,
  CodexControlTransportShape
>()("@akua-dev/codex-router/CodexControlTransport") {}

export const makeFetchCodexControlTransport = (
  fetchImplementation: (request: Request) => Promise<Response> = fetch
): CodexControlTransportShape =>
  CodexControlTransport.of({
    execute: Effect.fn("CodexControlTransport.execute")(function* (request) {
      return yield* Effect.tryPromise({
        try: () => fetchImplementation(request),
        catch: () =>
          new CodexControlTransportError({
            message: "The Codex control-plane request did not complete"
          })
      })
    })
  })
