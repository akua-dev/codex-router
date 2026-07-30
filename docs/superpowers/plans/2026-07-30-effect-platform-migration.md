# Effect Platform Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every applicable handwritten runtime and infrastructure abstraction with the
official aligned Effect implementation while preserving subscription-only routing, exact opaque
model streaming, single transmission, and both Cloudflare Worker and Bun/AgentOS operation.

**Architecture:** Keep portable policy and protocol code in `packages/core` and `packages/codex`.
Compose Effect HTTP applications and services in the runtime packages. Use the official Durable
Object SQLite adapter and migrator, official Bun runtime/platform services, Fetch-based Effect
clients for decoded control traffic, and native Web transport only for the opaque model hop. Treat
Bun entrypoints, Worker callbacks, Durable Object callbacks, and the original streamed Web response
as explicit runtime boundaries.

**Tech Stack:** Bun, TypeScript, Effect `4.0.0-beta.102`, `@effect/platform-bun`,
`@effect/platform-browser`, `@effect/sql-sqlite-bun`, `@effect/sql-sqlite-do`, `@effect/vitest`,
Vitest, Cloudflare Workers, SQLite Durable Objects, Wrangler, Docker, Kubernetes.

## Global Constraints

- Work directly on `main`, as authorized in `AGENTS.md`; keep each completed slice committed.
- Use `.agents/skills/effect-ts/SKILL.md` and the pinned `.repos/effect` source for Effect APIs.
- Keep every Effect package on exactly the same verified version.
- Start each behavior change with a focused failing test, confirm the intended failure, make the
  smallest implementation change, then run the focused and full relevant suites.
- Never read, clone, tee, hash, buffer, retry, or reconstruct an opaque model request or response
  body.
- Keep native Web `Request`, `Response`, and `ReadableStream` only at the exact-stream transport and
  lifetime boundary.
- Decode external environment, JSON, SQL, JWT, OAuth, usage, Durable Object RPC, and encrypted
  envelope values with `Schema`.
- Model expected failures with tagged errors and translate foreign errors once at adapter boundaries
  without including secrets.
- Use one named layer value per application composition so Layer memoization is preserved.
- Do not add D1, Cloudflare Workflows, Effect AI, semantic routing, provider API keys, model-payload
  observability, or model retries.

---

## Task 1: Lock the Effect dependency surface

**Files:**

- Modify: `package.json`
- Modify: `packages/cloudflare/package.json`
- Modify: `packages/bun/package.json`
- Modify: `apps/server/package.json`
- Modify: `apps/relay/package.json`
- Modify: `bun.lock`

- [ ] Reconfirm the current official mutually aligned versions of `effect`, `@effect/platform-bun`,
      `@effect/platform-browser`, `@effect/sql-sqlite-bun`, `@effect/sql-sqlite-do`, and
      `@effect/vitest`.
- [ ] Add `@effect/platform-browser` and `@effect/sql-sqlite-do` to the Cloudflare package.
- [ ] Add `@effect/platform-bun` to packages or apps that import its runtime, HTTP server,
      filesystem, crypto, or HTTP client modules directly.
- [ ] Run `bun install`, inspect the lockfile for version drift or duplicate Effect cores, and run
      the baseline `bun run typecheck`.
- [ ] Commit the aligned dependency slice.

## Task 2: Centralize Effect encoding and secret comparison

**Files:**

- Create: `packages/codex/src/secure-compare.ts`
- Create: `packages/codex/test/secure-compare.test.ts`
- Modify: `packages/codex/src/credentials.ts`
- Modify: `packages/codex/src/index.ts`
- Modify: `packages/codex/test/credentials.test.ts`
- Modify: `packages/bun/src/layers.ts`
- Modify: relevant Bun authentication tests

- [ ] Add failing Effect tests for equal and unequal secrets, different lengths, invalid Base64URL,
      and JWT parsing compatibility.
- [ ] Implement fixed-length SHA-256 secret comparison with `Crypto.Crypto.digest` and
      `Encoding.encodeBase64Url` / `Encoding.decodeBase64Url`.
- [ ] Replace Node `timingSafeEqual` and handwritten portable Base64URL helpers.
- [ ] Supply `BunCrypto.layer` at the Bun composition boundary rather than importing Node crypto.
- [ ] Run the focused Codex and Bun tests, then `bun run typecheck`.
- [ ] Commit the encoding and secret-comparison slice.

## Task 3: Move decoded outbound traffic to Effect HttpClient

**Files:**

- Modify: `packages/codex/src/control-transport.ts`
- Modify: `packages/codex/src/oauth.ts`
- Modify: `packages/codex/src/usage.ts`
- Modify: `packages/codex/src/maintenance.ts`
- Modify: `packages/codex/src/index.ts`
- Modify: `packages/codex/test/control-transport.test.ts`
- Modify: OAuth, usage, and maintenance tests
- Modify: `packages/cloudflare/src/control-transport.ts`
- Modify: Cloudflare control-transport tests
- Modify: `packages/bun/src/remote-account-admin.ts`
- Modify: Bun remote-admin tests

- [ ] Add failing tests with a deterministic `HttpClient` for transport defects, status
      classification, header handling, Schema-decoded JSON, gateway decoration, and redaction.
- [ ] Change `CodexControlTransport` to return Effect `HttpClientResponse` values and expose an
      official `HttpClient`-backed layer.
- [ ] Convert Web requests with Effect HTTP request constructors; decode JSON through response
      Effects and existing Schemas.
- [ ] Make Worker control routing an `HttpClient` decorator and make Bun remote administration use
      the supplied official client.
- [ ] Keep `UpstreamTransport` native and unchanged for the opaque model hop.
- [ ] Run the focused tests, the Codex/Bun/Cloudflare suites, and `bun run typecheck`.
- [ ] Commit the control-plane HTTP slice.

## Task 4: Use Effect Crypto, Clock, and Encoding in runtime adapters

**Files:**

- Modify: `packages/bun/src/sqlite-account-store.ts`
- Modify: `packages/bun/src/sqlite-routing-state.ts`
- Modify: their tests
- Modify: `packages/cloudflare/src/config.ts`
- Modify: `packages/cloudflare/src/credential-cipher.ts`
- Modify: `packages/cloudflare/src/application.ts`
- Modify: `packages/cloudflare/src/router-state-object.ts`
- Modify: `packages/cloudflare/test/config.test.ts`
- Modify: `packages/cloudflare/test/credential-cipher.test.ts`
- Modify: application and Durable Object tests
- Modify: `packages/relay/src/handler.ts`
- Modify: relay tests

- [ ] Add failing tests proving deterministic injected UUID/nonce generation, preserved envelope
      format and AAD, invalid keyring classification, and clock-driven timing.
- [ ] Replace runtime `crypto.randomUUID`, digest, random byte, and handwritten Base64URL calls with
      `Crypto.Crypto` and `Encoding`.
- [ ] Keep AES-256-GCM in Web Crypto behind the existing typed Effect cipher service because Effect
      does not expose symmetric AES.
- [ ] Replace application wall-clock reads and owned artificial delays with `Clock` and
      `Effect.sleep`; keep explicit `now` parameters in deterministic domain and transactional APIs.
- [ ] Supply `BunCrypto.layer` in Bun and `BrowserCrypto.layer` in Workers.
- [ ] Run focused tests, runtime package tests, and `bun run typecheck`.
- [ ] Commit the crypto, encoding, and clock slice.

## Task 5: Replace raw Durable Object SQL with the official adapter

**Files:**

- Create: `packages/cloudflare/src/router-state-migrations.ts`
- Create: `packages/cloudflare/src/router-state-repository.ts`
- Create: `packages/cloudflare/test/router-state-repository.test.ts`
- Modify: `packages/cloudflare/src/router-state-object.ts`
- Modify: `packages/cloudflare/src/index.ts`
- Modify: `packages/cloudflare/test/router-state-object.test.ts`

- [ ] Add failing tests proving `effect_sql_migrations` initialization, compatibility with the
      existing logical schema/data, successful transaction commit, rollback after a failing
      multi-statement operation, and concurrent reservation correctness.
- [ ] Express the current non-destructive schema and indexes as ordered `SqliteMigrator` migrations;
      do not drop, rename, or rewrite deployed credential data.
- [ ] Build a repository on `@effect/sql-sqlite-do/SqliteClient` and
      `effect/unstable/sql/SqlClient`; Schema-decode rows at the repository boundary.
- [ ] Move acquisition, assignments, reservations, response health, refresh claims, generation
      checks, and administrative mutations into `SqlClient.withTransaction`.
- [ ] Make the Durable Object own one `ManagedRuntime` containing SQLite, migrator, Web Crypto,
      configuration, and repository layers. Keep only the public Cloudflare Promise boundary.
- [ ] Start migration and configured-account seeding inside `blockConcurrencyWhile`.
- [ ] Remove handwritten `storage.sql.exec`, `transactionSync`, custom migration bookkeeping, and
      internal `Effect.runPromise` calls.
- [ ] Run repository and Durable Object tests, the Cloudflare suite, `bun run typecheck`, and the
      Worker dry build.
- [ ] Commit the Durable Object SQL slice.

## Task 6: Make the inbound application Effect-first

**Files:**

- Create: `packages/codex/src/http-application.ts`
- Create: `packages/codex/test/http-application.test.ts`
- Modify: `packages/codex/src/handler.ts`
- Modify: `packages/codex/src/admin.ts`
- Modify: `packages/codex/src/index.ts`
- Modify: handler and admin tests
- Modify: `packages/cloudflare/src/application.ts`
- Modify: `packages/bun/src/application.ts`
- Modify: Worker and Bun application tests

- [ ] Add failing tests for Effect-router dispatch, auth-before-body-access, invalid
      method/path/session rejection, exact raw upstream response identity, and sanitized expected
      errors.
- [ ] Express health, status, administration, canary, key-version, and proxy dispatch with Effect
      `HttpRouter` and named Effect handlers.
- [ ] At the transparent route only, obtain the original Web request and return
      `HttpServerResponse.raw(originalResponse)` without body conversion.
- [ ] Preserve the compatibility fetch facade only as a thin boundary around the Effect application
      where existing public consumers require it.
- [ ] Compose runtime-specific services as Layers instead of scattered `Effect.provide` calls.
- [ ] Run focused tests, Codex/Bun/Cloudflare suites, the typecheck, and Worker dry build.
- [ ] Commit the portable inbound HTTP slice.

## Task 7: Host the Bun server with official platform services

**Files:**

- Modify: `packages/bun/src/server.ts`
- Modify: `packages/bun/src/layers.ts`
- Modify: `packages/bun/src/index.ts`
- Modify: `apps/server/src/main.ts`
- Modify: Bun server and application tests

- [ ] Add failing scoped tests proving listener acquisition, route service provision, interruption,
      and finalization.
- [ ] Replace direct `Bun.serve` with `BunHttpServer.layer`, `HttpRouter.serve`, and `Layer.launch`.
- [ ] Replace manual signal/shutdown promises with `BunRuntime.runMain`.
- [ ] Replace synchronous database-directory creation with Effect filesystem and path services from
      `BunServices`.
- [ ] Provide official Bun HTTP client and crypto layers once at the composition root.
- [ ] Run focused server tests, the Bun suite, `bun run typecheck`, and an actual local
      start/health/interrupt smoke test.
- [ ] Commit the Bun server runtime slice.

## Task 8: Host the relay with Effect HTTP and Stream

**Files:**

- Modify: `packages/relay/src/handler.ts`
- Modify: `packages/relay/src/index.ts`
- Modify: `apps/relay/src/main.ts`
- Modify: relay tests

- [ ] Add failing tests for Effect-router health/proxy dispatch, auth and allowlist ordering,
      no-redirect transport, raw opaque response preservation, and scoped shutdown.
- [ ] Convert relay routing and owned synthetic canary output to `HttpRouter`; use Effect `Stream`
      and `Clock` only for generated data.
- [ ] Keep native fetch and the original response body for the authenticated fixed upstream hop.
- [ ] Host with `BunHttpServer.layer`, `HttpRouter.serve`, `Layer.launch`, and `BunRuntime.runMain`.
- [ ] Run focused relay tests, `bun run typecheck`, and a local relay health/interrupt smoke test.
- [ ] Commit the relay runtime slice.

## Task 9: Bridge the Effect application into Cloudflare correctly

**Files:**

- Modify: `packages/cloudflare/src/worker.ts`
- Modify: `packages/cloudflare/src/application.ts`
- Modify: `apps/worker/src/index.ts`
- Modify: Worker tests

- [ ] Add failing tests proving bindings are invocation-scoped and runtime disposal occurs after
      empty, complete, cancelled, and errored native response bodies.
- [ ] Use the Effect Web-handler bridge for request routing while decoding and providing the Worker
      environment per invocation.
- [ ] Keep the response-lifetime wrapper around native model streams so the request scope survives
      until completion/cancellation; never retain request bindings globally.
- [ ] Run cron maintenance through the same named Effect workflow and pass its Promise to
      `waitUntil`.
- [ ] Run focused Worker tests, the Cloudflare suite, `bun run typecheck`, and the Worker dry build.
- [ ] Commit the Worker bridge slice.

## Task 10: Prove all protocol and race invariants

**Files:**

- Modify: existing tests across `packages/core`, `packages/codex`, `packages/bun`,
  `packages/cloudflare`, and `packages/relay`
- Modify: `scripts/synthetic-canary.test.ts`

- [ ] Add or retain regression tests for generation-safe refresh, usage, and response commits;
      reservation races; claim expiry; sticky selection; and stale-usage policy.
- [ ] Prove model body methods, `clone`, and `tee` are never invoked before or during forwarding.
- [ ] Prove request transmission count is exactly one across success, provider error, stream error,
      cancellation, and bookkeeping failure.
- [ ] Prove status, status text, safe headers, chunk sequence, and bytes survive Bun, Worker, AI
      Gateway encapsulation, and relay paths.
- [ ] Prove the synthetic stream keeps its intentional multibyte split.
- [ ] Convert Effect workflow tests to `@effect/vitest`, test Layers, and `TestClock`; retain native
      async tests only for host Web-stream semantics.
- [ ] Run `bun test`, `bun run typecheck`, and `bun run build:worker`.
- [ ] Commit the invariant-test slice.

## Task 11: Synchronize engineering and operations documentation

**Files:**

- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/operations.md`
- Modify: `docs/canary.md`
- Modify: `docs/research.md`
- Modify: `docs/security.md`

- [ ] Document each official Effect capability now in use and why native Web streaming and Web
      Crypto AES remain deliberate exceptions.
- [ ] Document Durable Object Effect migrations, Bun/Worker composition, control-plane HttpClient,
      resource lifetimes, scheduling, and operational migration behavior.
- [ ] Remove stale descriptions of handwritten SQL, manual Bun hosting, and native control fetch.
- [ ] Preserve subscription-only, Terms/privacy caveats, metadata-only Gateway behavior, and the
      distinction between transport credentials and model credentials.
- [ ] Do not claim D1, Workflows, semantic routing, OpenAI API-key support, WebSockets, or automatic
      Workers Free-tier eligibility.
- [ ] Run formatting and repository-wide documentation/placeholder scans.
- [ ] Commit the documentation slice.

## Task 12: Full verification and no-mistakes review

**Files:**

- Inspect all changed production, test, deployment, and documentation files

- [ ] Run `bun run format`.
- [ ] Run `bun run check` and preserve the complete passing output.
- [ ] Run `git diff --check`.
- [ ] Scan changed code for `any`, unsafe double casts, non-null assertions, raw unknown probing,
      scattered runtime execution/provision, body reads, clones/tees, duplicate transmissions,
      secret-like literals, API-key claims, and unfinished markers.
- [ ] Inspect dependency direction and ensure no runtime imports entered `packages/core` or
      `packages/codex`.
- [ ] Run the no-mistakes review pipeline without mutating any unrelated PR or user work.
- [ ] Fix each real finding test-first, rerun the relevant focused test, then rerun the complete
      gate.
- [ ] Commit any review fixes.

## Task 13: Build, deploy, and verify the relay

**Files:**

- Runtime sources and `Dockerfile.relay`

- [ ] Resolve the existing immutable image naming, registry, namespace, deployment, and container
      targets from repository docs and the live AgentOS cluster.
- [ ] Build the relay image from the verified commit, push it under a new immutable tag, and record
      its digest.
- [ ] Update only the intended Kubernetes deployment to that immutable image.
- [ ] Wait for rollout completion and verify pod readiness, image digest, logs, and health without
      exposing credentials.
- [ ] Run the relay path of the exact-byte synthetic canary.
- [ ] Record sanitized evidence in `docs/canary.md`, commit it, and rerun the documentation checks.

## Task 14: Deploy and verify the Cloudflare Worker

**Files:**

- `apps/worker/wrangler.jsonc`
- Built Worker artifact
- `docs/canary.md`

- [ ] Deploy the exact verified commit with Wrangler or Cloudflare control-plane tooling.
- [ ] Verify the deployed Worker version, bindings, Durable Object migration startup, cron trigger,
      and error-free logs.
- [ ] Run the complete synthetic exact-byte canary, including status, headers, chunk sequence,
      multibyte split, cancellation, and single-transmission assertions.
- [ ] Run one minimal real Codex subscription canary and confirm quota/account state commits without
      logging tokens or payloads.
- [ ] Inspect Cloudflare AI Gateway request metadata and confirm prompt/response logging and cache
      remain disabled and the SSE octet-stream encapsulation remains byte-exact.
- [ ] Record sanitized deployed evidence in `docs/canary.md`, commit it, and rerun `bun run check`
      plus `git diff --check`.

## Task 15: Synchronize and push verified main

**Files:**

- Repository history and remote `main`

- [ ] Fetch the remote with `gh-axi`/Git, inspect divergence, and rebase or integrate only if safe
      without discarding user work.
- [ ] Confirm the working tree is clean and the local verified commit is the exact deployment
      source.
- [ ] Push directly to `main`.
- [ ] Verify local `HEAD`, remote `main`, the deployed Worker version, and relay image source all
      identify the same final source state.
- [ ] Mark the goal complete only after no required implementation, verification, deployment, or
      synchronization work remains.
