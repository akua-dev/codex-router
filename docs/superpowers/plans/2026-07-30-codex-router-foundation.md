# Codex Router Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and publish the tested Effect-first Codex Router foundation with
portable routing/protocol packages and working Cloudflare Worker and Bun
adapters.

**Architecture:** A Bun workspace keeps routing policy and Web Platform request
handling independent of runtime APIs. Effect services and layers supply
strongly consistent routing state, credentials, quota probes, transport, and
telemetry; Cloudflare Durable Object and Bun SQLite implementations satisfy the
same contracts.

**Tech Stack:** Bun 1.4, TypeScript 7, Effect 4 beta, `@effect/vitest`, Vitest,
SQLite, Cloudflare Workers, Durable Objects, Wrangler, Web Crypto.

## Global Constraints

- Install the exact `effect@beta` and aligned `@effect/*@beta` versions.
- Use Bun for package management, scripts, tests, and the portable server.
- Use strict TypeScript with no `any`, casts, namespaces, or unchecked external
  input.
- Keep `packages/core` and `packages/codex` free of Bun, Node, and Cloudflare
  imports.
- Authenticate before consuming a request body.
- Never persist or log credentials, prompts, responses, authorization headers,
  provider account IDs, or full upstream errors.
- Never buffer, clone for reading, or semantically rewrite upstream streams.
- Never replay a request after upstream transmission.
- Never use Workers KV for quota, leases, cooldowns, or session assignments.
- HTTP and SSE are released; transparent Responses WebSockets are explicitly
  unsupported.
- Write each behavior test first and observe its expected failure before adding
  production code.

---

### Task 1: Repository and Official Effect Foundation

**Files:**

- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `oxlint.json`
- Create: `.prettierrc.json`
- Create: `.gitignore`
- Create: `.agents/skills/effect-ts/**`
- Create: `skills-lock.json`
- Create: `.gitmodules`
- Create: `.repos/effect`
- Create: `packages/{core,codex,cloudflare,bun}/package.json`
- Create: `apps/{worker,server}/package.json`

**Interfaces:**

- Consumes: approved design and official `Effect-TS/skills`.
- Produces: reproducible Bun workspace, official project skill, pinned Effect
  source, and package import graph.

- [ ] **Step 1: Install the official Effect skill**

Run:

```bash
bunx --bun skills add Effect-TS/skills \
  --skill effect-ts --agent codex --copy -y
```

Expected: `.agents/skills/effect-ts/SKILL.md`, all official references, and
`skills-lock.json` exist.

- [ ] **Step 2: Pin the Effect source prerequisite**

Run:

```bash
git submodule add https://github.com/Effect-TS/effect.git .repos/effect
```

Expected: `.gitmodules` and a pinned `.repos/effect` gitlink exist.

- [ ] **Step 3: Add workspace configuration**

Create a root `package.json` whose scripts are:

```json
{
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "lint": "oxlint .",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "build:worker": "wrangler deploy --dry-run --config apps/worker/wrangler.jsonc",
    "check": "bun run format:check && bun run lint && bun run typecheck && bun test && bun run build:worker"
  }
}
```

Use workspaces `packages/*` and `apps/*`; mark the root private.

- [ ] **Step 4: Install exact dependencies**

Run:

```bash
bun add --dev --exact \
  effect@beta @effect/vitest@beta @effect/platform-bun@beta \
  @cloudflare/workers-types@latest @types/bun@latest \
  oxlint@latest prettier@latest typescript@latest vite@latest \
  vitest@latest wrangler@latest
```

Expected: `bun.lock` resolves one aligned Effect beta version.

- [ ] **Step 5: Verify the empty workspace**

Run:

```bash
bun run typecheck
bun run lint
bun run format:check
```

Expected: all commands exit zero.

- [ ] **Step 6: Commit**

```bash
git add .
git commit -m "build: initialize Effect Bun workspace"
```

### Task 2: Portable Domain and Selection Policy

**Files:**

- Create: `packages/core/src/model.ts`
- Create: `packages/core/src/errors.ts`
- Create: `packages/core/src/selection.ts`
- Create: `packages/core/src/index.ts`
- Create: `packages/core/test/selection.test.ts`

**Interfaces:**

- Produces:
  - schema classes `UsageWindow`, `UsageSnapshot`, `Candidate`,
    `CandidateExplanation`, and `SelectionDecision`
  - branded schemas `AccountId`, `SessionKey`, and `LeaseToken`
  - `RoutingConfig` and `defaultRoutingConfig`
  - `selectAccount(input): Effect<SelectionDecision>`

- [ ] **Step 1: Write failing selection tests**

Cover these concrete cases in `selection.test.ts` using `it.effect`:

```ts
it.effect("keeps an eligible sticky account inside hysteresis", () =>
  Effect.gen(function*() {
    const decision = yield* selectAccount({
      candidates: [candidateA, candidateB],
      config: defaultRoutingConfig,
      now,
      currentAccountId: candidateA.accountId
    })
    assert.strictEqual(decision.accountId, candidateA.accountId)
    assert.strictEqual(decision.reason, "current_account_hysteresis")
  })
)
```

Also assert rejection of reauthentication, active blocks, unknown usage, expired
weekly reset, short headroom, weekly headroom, snapshots older than 24 hours,
stale-data penalty, reset urgency, reservation-count tie breaks, and stable
opaque-ID ties.

- [ ] **Step 2: Run and observe RED**

Run:

```bash
bun test packages/core/test/selection.test.ts
```

Expected: failure because `packages/core/src/selection.ts` does not exist.

- [ ] **Step 3: Implement schema-backed models and policy**

Use `Schema.Class`, `Schema.TaggedClass`, branded strings, `Schema.optionalKey`,
and a named `Effect.fn("selectAccount")`. Return stable reason and rejection
codes. Apply:

```ts
const urgency = remainingWeekly / Math.max(0.25, hoursUntilReset)
```

Use a five-point stale penalty, 24-hour maximum age, 10% short-window minimum,
3% weekly minimum, and 10% hysteresis.

- [ ] **Step 4: Run and observe GREEN**

Run:

```bash
bun test packages/core/test/selection.test.ts
bun run typecheck
```

Expected: all selection tests and type checking pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): add quota-aware account selection"
```

### Task 3: Portable Routing State and Response Classification

**Files:**

- Create: `packages/core/src/services.ts`
- Create: `packages/core/src/routing.ts`
- Create: `packages/core/src/upstream-status.ts`
- Create: `packages/core/src/testing/in-memory-routing-state.ts`
- Create: `packages/core/test/routing.test.ts`
- Create: `packages/core/test/upstream-status.test.ts`

**Interfaces:**

- Produces:
  - `RoutingState` Effect service
  - `RouteLease`, `AcquireRouteInput`, `RoutingSummary`
  - `acquireRoute`, `renewRoute`, `releaseRoute`, `recordUpstreamResponse`
  - in-memory transactional test layer
  - `classifyUpstreamResponse(status, headers, now)`

- [ ] **Step 1: Write failing state contract tests**

Tests must run concurrent acquisitions and verify:

```ts
const leases = yield* Effect.all(
  Array.from({ length: 20 }, (_, index) =>
    state.acquire({
      candidates,
      now,
      sessionKey: SessionKey.make(`session-${index}`)
    })
  ),
  { concurrency: "unbounded" }
)
assert.strictEqual(leases.filter(Option.isSome).length, 20)
```

Also cover expired lease cleanup, assignment TTL, explicit-only stickiness,
renewal, release, quota block replacement, and sanitized summaries.

- [ ] **Step 2: Write failing classification tests**

Assert:

- `401` produces `reauth`
- `429` parses numeric and HTTP-date `Retry-After`
- `403`, `404`, and `5xx` remain distinct non-quota classifications
- successful responses produce no account block

- [ ] **Step 3: Run and observe RED**

```bash
bun test packages/core/test/routing.test.ts \
  packages/core/test/upstream-status.test.ts
```

Expected: missing service and classification modules.

- [ ] **Step 4: Implement minimal Effect services**

Use `Context.Service`, `Layer.effect`, `Ref` or `SynchronizedRef` for the test
implementation, schema-backed typed errors, and `Effect.fn` business
operations. Keep atomic acquisition inside one service method.

- [ ] **Step 5: Run and observe GREEN**

```bash
bun test packages/core
bun run typecheck
```

Expected: all core tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core
git commit -m "feat(core): add transactional routing contracts"
```

### Task 4: Codex Protocol, Quota, and Transparent Handler

**Files:**

- Create: `packages/codex/src/usage.ts`
- Create: `packages/codex/src/protocol.ts`
- Create: `packages/codex/src/session.ts`
- Create: `packages/codex/src/headers.ts`
- Create: `packages/codex/src/services.ts`
- Create: `packages/codex/src/handler.ts`
- Create: `packages/codex/src/index.ts`
- Create: `packages/codex/test/usage.test.ts`
- Create: `packages/codex/test/handler.test.ts`

**Interfaces:**

- Produces:
  - `decodeCodexUsage(unknown, observedAt, accountId)`
  - `resolveUpstreamTarget(path, accountKind)`
  - `extractSessionKey(headers)`
  - `sanitizeRequestHeaders` and `sanitizeResponseHeaders`
  - Effect services `ClientAuthenticator`, `AccountDirectory`,
    `UsageProbe`, `UpstreamTransport`, and `GatewayTelemetry`
  - `makeRouterFetch(): Effect<(request: Request) => Promise<Response>>`

- [ ] **Step 1: Write failing quota tests**

Cover snake-case and camel-case usage shapes, second/millisecond reset
normalization, 18,000-second and 604,800-second window classification,
percentage clamping, credits, and rejection of unknown durations or malformed
objects.

- [ ] **Step 2: Run quota tests and observe RED**

```bash
bun test packages/codex/test/usage.test.ts
```

Expected: missing usage module.

- [ ] **Step 3: Implement quota decoding**

Decode unknown values with Effect Schema and return a typed `UsageSnapshot`.
Do not use casts or raw unchecked property access.

- [ ] **Step 4: Write failing handler tests**

Use a request body stream whose `pull` records access and assert:

```ts
const response = await fetch(new Request(url, {
  method: "POST",
  body,
  duplex: "half"
}))
assert.strictEqual(response.status, 401)
assert.isFalse(bodyWasPulled)
```

Also test every supported path, unsupported methods, explicit session headers,
256-character bounds, credential stripping, selected authorization injection,
opaque SSE byte preservation, safe response headers, empty bodies, completion,
cancellation, transport failure, bookkeeping failure, and compaction payloads.

- [ ] **Step 5: Run handler tests and observe RED**

```bash
bun test packages/codex/test/handler.test.ts
```

Expected: missing handler and service modules.

- [ ] **Step 6: Implement one-shot transparent forwarding**

Create the runtime once with `ManagedRuntime`. Acquire one lease, obtain one
credential, perform one fetch, record only status/header bookkeeping, and wrap
the body only to release the lease. Never read the body.

- [ ] **Step 7: Run and observe GREEN**

```bash
bun test packages/codex
bun run typecheck
```

Expected: protocol tests pass and portable packages have no runtime-specific
imports.

- [ ] **Step 8: Commit**

```bash
git add packages/codex
git commit -m "feat(codex): add transparent Responses routing"
```

### Task 5: Bun SQLite Runtime

**Files:**

- Create: `packages/bun/src/sqlite-routing-state.ts`
- Create: `packages/bun/src/config.ts`
- Create: `packages/bun/src/layers.ts`
- Create: `packages/bun/src/server.ts`
- Create: `packages/bun/src/index.ts`
- Create: `packages/bun/test/sqlite-routing-state.test.ts`
- Create: `packages/bun/test/server.test.ts`
- Create: `apps/server/src/main.ts`

**Interfaces:**

- Consumes: portable routing and handler services.
- Produces: SQLite `RoutingState` layer and Bun fetch/server composition.

- [ ] **Step 1: Write failing SQLite contract tests**

Run the same routing-state behaviors against a temporary SQLite database. Add a
second instance pointed at the same file and prove transactionally visible
leases and assignments.

- [ ] **Step 2: Run and observe RED**

```bash
bun test packages/bun/test/sqlite-routing-state.test.ts
```

Expected: missing Bun SQLite adapter.

- [ ] **Step 3: Implement SQLite transactions**

Create versioned migrations and tables for assignments, reservations, blocks,
and usage snapshots. Use one immediate transaction for acquisition and one
statement batch for expiry cleanup. Parameterize all SQL.

- [ ] **Step 4: Write failing server smoke test**

Build the Bun fetch composition with test layers and assert `/healthz`,
authenticated `/status`, and one streamed `/responses` request.

- [ ] **Step 5: Implement Bun composition**

Decode environment through Schema, compose layers once, and expose both a fetch
function and `Bun.serve` entrypoint. The default topology remains one replica
when SQLite is on a PVC.

- [ ] **Step 6: Run and observe GREEN**

```bash
bun test packages/bun
bun run typecheck
```

Expected: Bun runtime tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/bun apps/server
git commit -m "feat(bun): add SQLite server runtime"
```

### Task 6: Cloudflare Durable Object and Worker

**Files:**

- Create: `packages/cloudflare/src/config.ts`
- Create: `packages/cloudflare/src/credential-cipher.ts`
- Create: `packages/cloudflare/src/router-state-object.ts`
- Create: `packages/cloudflare/src/ai-gateway-transport.ts`
- Create: `packages/cloudflare/src/worker.ts`
- Create: `packages/cloudflare/src/index.ts`
- Create: `packages/cloudflare/test/credential-cipher.test.ts`
- Create: `packages/cloudflare/test/ai-gateway-transport.test.ts`
- Create: `packages/cloudflare/test/worker.test.ts`
- Create: `apps/worker/src/index.ts`
- Create: `apps/worker/wrangler.jsonc`

**Interfaces:**

- Consumes: portable routing and Codex handler.
- Produces: Worker fetch handler, SQLite Durable Object class, AES-GCM
  credential cipher, and metadata-only AI Gateway transport.

- [ ] **Step 1: Write failing cipher tests**

Generate a test key and assert ciphertext round-trip, random nonces, AAD-bound
account IDs, wrong-key rejection, and secret redaction.

- [ ] **Step 2: Run and observe RED**

```bash
bun test packages/cloudflare/test/credential-cipher.test.ts
```

Expected: missing cipher module.

- [ ] **Step 3: Implement Web Crypto cipher**

Use AES-256-GCM with a 96-bit random nonce, explicit key version, account ID as
additional authenticated data, and schema-decoded ciphertext envelopes.

- [ ] **Step 4: Write failing AI Gateway and Worker tests**

Assert the outbound request contains:

```ts
assert.strictEqual(headers.get("cf-aig-skip-cache"), "true")
assert.strictEqual(headers.get("cf-aig-collect-log-payload"), "false")
```

Assert the AI Gateway token is injected only inside the Worker, metadata omits
credentials and payloads, bindings are schema-decoded, and Durable Object RPC
occurs outside the streamed response path.

- [ ] **Step 5: Implement Worker adapters**

Use Durable Object SQLite for the same routing-state contract. Keep RPC methods
short. Create `wrangler.jsonc` with the Durable Object binding and migration,
compatibility date `2026-07-30`, observability enabled, and no committed
secrets.

- [ ] **Step 6: Verify the Worker**

```bash
bun test packages/cloudflare
bun run typecheck
bun run build:worker
```

Expected: tests pass and Wrangler produces a dry-run bundle.

- [ ] **Step 7: Commit**

```bash
git add packages/cloudflare apps/worker
git commit -m "feat(cloudflare): add Worker and Durable Object runtime"
```

### Task 7: Project Instructions and Operator Documentation

**Files:**

- Create: `AGENTS.md`
- Create: `README.md`
- Create: `docs/architecture.md`
- Create: `docs/operations.md`
- Create: `docs/research.md`
- Create: `docs/security.md`
- Create: `LICENSE`

**Interfaces:**

- Consumes: validated design, local Codex audit, AgentOS implementation
  evidence, official Cloudflare/OpenAI/Effect documentation.
- Produces: complete project vision, development rules, failure-mode catalogue,
  operator runbook, and source-backed research record.

- [ ] **Step 1: Write `AGENTS.md`**

Include the entire vision, runtime boundaries, Effect rules, compatibility
contract, security invariants, request-volume baseline, Cloudflare limits,
AgentOS/Pi learnings, forbidden mistakes, TDD commands, delivery rules, and
documentation ownership.

- [ ] **Step 2: Write user and operator documentation**

Document local Bun startup, Worker configuration, secrets, AI Gateway custom
provider flow, Kubernetes/PVC posture, metadata-only logging, status endpoints,
OAuth compatibility risk, canary metrics, rollback, and current limitations.

- [ ] **Step 3: Verify documentation**

Run:

```bash
rg -n 'TBD|TODO|FIXME|<YOUR_|changeme|example-secret' .
rg -n 'authorization|refreshToken|accessToken|chatgpt-account-id' \
  AGENTS.md README.md docs
bun run format:check
```

Expected: no placeholders or credential examples; sensitive terms occur only in
explicit prohibitions and architectural explanations.

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md README.md LICENSE docs
git commit -m "docs: define operations and project invariants"
```

### Task 8: Verification, Publication, and Main

**Files:**

- Modify only files required by fresh verification failures.

**Interfaces:**

- Consumes: complete repository.
- Produces: verified local `main` and public `akua-dev/codex-router` remote.

- [ ] **Step 1: Run the full gate**

```bash
bun run check
git diff --check
git status --short --branch
```

Expected: all checks exit zero and the worktree is clean.

- [ ] **Step 2: Audit requirements**

Prove each objective item from current files and command output:

- target directory
- Bun workspace
- latest official Effect beta and official skill
- portable abstractions
- Worker and Durable Object adapter
- Bun and Kubernetes-compatible adapter
- comprehensive `AGENTS.md`
- restored research and failure modes
- tests and documentation
- clean verified `main`

- [ ] **Step 3: Create and push the GitHub repository**

Run exactly once after confirming it is still absent:

```bash
gh-axi repo create akua-dev/codex-router \
  --public --source . --remote origin --push
```

Expected: GitHub repository exists and its default branch is `main`.

- [ ] **Step 4: Verify the remote**

```bash
git fetch origin main
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
gh-axi repo view -R akua-dev/codex-router
```

Expected: local and remote `main` resolve to the same commit.

