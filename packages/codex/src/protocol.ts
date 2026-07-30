export type SupportedResponsePath =
  | "/responses"
  | "/v1/responses"
  | "/codex/responses"
  | "/responses/compact"
  | "/v1/responses/compact"

export const supportedResponsePaths: ReadonlyArray<SupportedResponsePath> = [
  "/responses",
  "/v1/responses",
  "/codex/responses",
  "/responses/compact",
  "/v1/responses/compact"
]

export const isSupportedResponsePath = (path: string): path is SupportedResponsePath =>
  supportedResponsePaths.some((supported) => supported === path)

export const resolveUpstreamTarget = (_path: string): string =>
  "https://chatgpt.com/backend-api/codex/responses"
