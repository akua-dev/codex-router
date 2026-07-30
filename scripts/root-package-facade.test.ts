import { describe, expect, it } from "vitest"

describe("root package facade", () => {
  it("exposes every supported runtime boundary from one package", async () => {
    const [core, codex, bun, cloudflare, relay] = await Promise.all([
      import("@akua-dev/codex-router/core"),
      import("@akua-dev/codex-router/codex"),
      import("@akua-dev/codex-router/bun"),
      import("@akua-dev/codex-router/cloudflare"),
      import("@akua-dev/codex-router/relay")
    ])

    expect(core.selectAccount).toBeTypeOf("function")
    expect(codex.makeRouterFetch).toBeTypeOf("function")
    expect(bun.openSqliteRoutingState).toBeTypeOf("function")
    expect(cloudflare.makeWorkerFetch).toBeTypeOf("function")
    expect(relay.makeCodexEgressRelay).toBeTypeOf("function")
  })
})
