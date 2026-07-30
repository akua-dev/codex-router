import { makeRemoteAccountAdminClient, runRemoteDeviceLogin } from "@akua-dev/codex-router-bun"
import { makeFetchCodexControlTransport, makeOpenAiOAuthClient } from "@akua-dev/codex-router-codex"
import { AccountId } from "@akua-dev/codex-router-core"
import { Console, Effect, Redacted, Schema } from "effect"

class AdminCliError extends Schema.TaggedErrorClass<AdminCliError>()("AdminCliError", {
  message: Schema.String
}) {}

const fail = (message: string) => new AdminCliError({ message })

const argumentValue = (arguments_: ReadonlyArray<string>, name: string): string | undefined => {
  const index = arguments_.indexOf(name)
  return index === -1 ? undefined : arguments_[index + 1]
}

const decodeAccountId = Schema.decodeUnknownEffect(AccountId)

const program = Effect.fn("CodexRouterAdminCli.program")(function* (
  arguments_: ReadonlyArray<string>,
  environment: Readonly<Record<string, string | undefined>>
) {
  const command = arguments_[0]
  const account = arguments_[1]
  const baseUrl = argumentValue(arguments_, "--remote") ?? environment.CODEX_ROUTER_ADMIN_URL
  const adminToken = environment.CODEX_ROUTER_ADMIN_TOKEN

  if (command === undefined || baseUrl === undefined || adminToken === undefined) {
    return yield* fail(
      "Usage: admin:bun <login|list|enable|disable|remove> [account-id] --remote <https-url>"
    )
  }

  const admin = yield* makeRemoteAccountAdminClient({
    adminToken: Redacted.make(adminToken),
    baseUrl
  })

  if (command === "list") {
    const accounts = yield* admin.list()
    yield* Console.log(JSON.stringify({ accounts }, undefined, 2))
    return
  }

  if (account === undefined) {
    return yield* fail("An opaque account id is required for this command")
  }
  const accountId = yield* decodeAccountId(account).pipe(
    Effect.mapError(() => fail("The account id is invalid"))
  )

  if (command === "login") {
    const oauth = makeOpenAiOAuthClient({
      transport: makeFetchCodexControlTransport()
    })
    const summary = yield* runRemoteDeviceLogin({
      accountId,
      admin,
      oauth,
      onInstruction: Console.log
    })
    yield* Console.log(
      `Stored account ${summary.accountId} at credential generation ${summary.generation ?? 1}`
    )
    return
  }

  if (command === "enable" || command === "disable") {
    const summary = yield* admin.setEnabled(accountId, command === "enable")
    yield* Console.log(`Account ${summary.accountId} enabled=${String(summary.enabled)}`)
    return
  }

  if (command === "remove") {
    const removed = yield* admin.remove(accountId)
    yield* Console.log(
      removed ? `Removed account ${accountId}` : `Account ${accountId} was not found`
    )
    return
  }

  return yield* fail("The administration command is not supported")
})

await Effect.runPromise(
  program(process.argv.slice(2), process.env).pipe(
    Effect.catch((error) => Console.error(error.message).pipe(Effect.andThen(Effect.fail(error))))
  )
)
