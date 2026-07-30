import {
  RouterStateObject,
  decodeWorkerBindings,
  makeCloudflareWorkerApplication,
  makeWorkerEntrypoint
} from "@akua-dev/codex-router-cloudflare"
import { Effect } from "effect"

export { RouterStateObject }

export default makeWorkerEntrypoint((environment) =>
  Effect.runPromise(decodeWorkerBindings(environment)).then(makeCloudflareWorkerApplication)
)
