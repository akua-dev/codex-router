# Subscription-Only Release Implementation Plan

> **Execution rule:** Follow this plan test-first. Run each focused test once in red, implement the
> smallest coherent behavior, rerun it in green, and commit the increment. Do not weaken an
> assertion to make an implementation pass.

**Goal:** Ship `codex-router` as a ChatGPT/Codex subscription-only load balancer with portable Effect
OAuth/quota orchestration, generation-safe persistence, Cloudflare cron and Bun schedules, secure
administration, key rotation, and verified Cloudflare AI Gateway streaming.

**Architecture:** `packages/core` owns generic quota/routing models. `packages/codex` owns
subscription credential, OAuth, usage, and router ports plus the transparent handler.
`packages/bun` and `packages/cloudflare` implement those ports with runtime storage and transport.
The Worker performs exactly three normal Durable Object calls and never sends model bodies through
the object.

**Stack:** Bun, TypeScript, Effect 4.0 beta, `@effect/vitest`, Effect Schema, Effect SQL SQLite Bun,
Cloudflare Workers, SQLite Durable Objects, Web Crypto AES-GCM, Wrangler, Cloudflare AI Gateway.

**Design:** `docs/superpowers/specs/2026-07-30-subscription-release-design.md`

## Global engineering constraints

- Keep `effect`, `@effect/vitest`, `@effect/platform-bun`, and `@effect/sql-sqlite-bun` on the exact
  latest aligned beta. Registry verification on 2026-07-30 reports `4.0.0-beta.102`.
- Read `.agents/skills/effect-ts/SKILL.md` and the relevant bundled guides before every Effect
  change.
- Use `Schema.Class`, `Schema.TaggedErrorClass`, `Redacted`, `Context.Service`, named `Layer`
  values, `Effect.fn`, and `ManagedRuntime`.
- No `any`, unchecked casts, non-null assertions, namespaces, raw property probing, expected thrown
  exceptions, or scattered provisioning.
- No model request/response body reads, clones, tees, or retries.
- No token, provider identity, ciphertext, nonce, full-header, or body logging.
- No API-key account kind or API upstream.

## Task 1: Make the protocol subscription-only

**Files:**

- Modify: `packages/codex/src/protocol.ts`
- Modify: `packages/codex/src/services.ts`
- Modify: `packages/codex/src/handler.ts`
- Modify: `packages/codex/test/handler.test.ts`
- Modify: `packages/bun/src/config.ts`
- Modify: `packages/cloudflare/src/config.ts`
- Modify: `packages/bun/test/config.test.ts`
- Modify: `packages/cloudflare/test/worker.test.ts`
- Modify: `AGENTS.md`

### Step 1: Write failing protocol/config tests

Change the handler fixture so every selected credential is a subscription credential. Assert:

```ts
expect(resolveUpstreamTarget("/v1/responses")).toBe(
  "https://chatgpt.com/backend-api/codex/responses"
)
expect(resolveUpstreamTarget("/responses/compact")).toBe(
  "https://chatgpt.com/backend-api/codex/responses/compact"
)
```

Delete the test fixture's `accountKind` option. Add config tests proving `kind` and API-key-shaped
accounts are rejected rather than ignored.

Run:

```bash
bun test packages/codex/test/handler.test.ts packages/bun/test/config.test.ts packages/cloudflare/test/worker.test.ts
```

Expected: failure because the current schema and target resolver still support
`openai_api_key`.

### Step 2: Remove the mode branches

- Delete `AccountKind`.
- Make `AccountCredential` subscription-only.
- Make `resolveUpstreamTarget(path)` unconditional.
- Remove `kind` from candidates and runtime configuration.
- Keep caller `api-key` and `x-api-key` removal in the header sanitizer because untrusted caller
  credentials must still be stripped.
- Rewrite the AGENTS product/protocol contract to subscription-only.

### Step 3: Verify and commit

```bash
bun test packages/codex/test/handler.test.ts packages/bun/test/config.test.ts packages/cloudflare/test/worker.test.ts
rg -n "openai_api_key|AccountKind" packages apps AGENTS.md
git diff --check
git add packages apps AGENTS.md
git commit -m "refactor: make routing subscription only"
```

The `rg` command must return no matches.

## Task 2: Add typed OAuth credential and usage boundaries

**Files:**

- Create: `packages/codex/src/credentials.ts`
- Create: `packages/codex/src/oauth.ts`
- Create: `packages/codex/src/oauth-client.ts`
- Create: `packages/codex/src/live-usage.ts`
- Create: `packages/codex/test/oauth.test.ts`
- Create: `packages/codex/test/live-usage.test.ts`
- Modify: `packages/codex/src/services.ts`
- Modify: `packages/codex/src/usage.ts`
- Modify: `packages/codex/src/index.ts`

### Step 1: Write failing schema and transport tests

Cover:

- credential generation is a positive integer
- access/refresh tokens are redacted
- JWT payload decoding extracts the ChatGPT account claim without exposing it in errors
- device-code start, pending poll, completion, and token refresh payloads
- refresh preserves the original refresh token when the provider omits a replacement
- provider identity mismatch returns a tagged `ProviderIdentityChanged`
- usage endpoint request contains selected bearer/account headers
- observed usage shapes normalize to the existing `UsageSnapshot`
- 401, 429, retryable HTTP, transport, and invalid payload are distinct tagged failures

Use a fixture `FetchTransport` service rather than global fetch mutation.

Run:

```bash
bun test packages/codex/test/oauth.test.ts packages/codex/test/live-usage.test.ts
```

Expected: module-not-found failures.

### Step 2: Implement portable services

Create schema-backed models:

```ts
class CredentialGeneration extends Schema.Int.pipe(Schema.positive()) {}

class SubscriptionCredential extends Schema.Class<SubscriptionCredential>(
  "SubscriptionCredential"
)({
  accessToken: RedactedSchema,
  refreshToken: RedactedSchema,
  expiresAt: Schema.Number,
  providerAccountId: RedactedSchema,
  generation: CredentialGeneration
}) {}
```

Define:

- `OAuthClient` with `startDeviceAuthorization`, `pollDeviceAuthorization`, and `refresh`
- `UsageProbe` with `getUsage`
- `CodexControlTransport` as the opaque HTTP boundary

Implement OpenAI device auth and refresh from the inspected MIT implementation, retaining required
license attribution in `NOTICE` or the source header. Use Schema at every response boundary and
Effect retry schedules only for retryable transport failures.

### Step 3: Verify and commit

```bash
bun test packages/codex/test/oauth.test.ts packages/codex/test/live-usage.test.ts
bun run typecheck
git diff --check
git add packages/codex NOTICE
git commit -m "feat(codex): add subscription oauth and live usage"
```

## Task 3: Add the portable generation-safe account coordinator

**Files:**

- Create: `packages/codex/src/account-store.ts`
- Create: `packages/codex/src/subscription-router.ts`
- Create: `packages/codex/src/testing/in-memory-account-store.ts`
- Create: `packages/codex/test/subscription-router.test.ts`
- Modify: `packages/codex/src/services.ts`
- Modify: `packages/codex/src/index.ts`
- Modify: `packages/codex/src/handler.ts`
- Modify: `packages/codex/test/handler.test.ts`

### Step 1: Write failing coordinator tests

Use Effect test layers and deterministic clocks. Cover:

- ten concurrent acquisitions trigger one credential refresh
- credentials refresh five minutes before expiry
- refresh commit increments generation
- identity mismatch marks only the current generation for reauthentication
- a late usage/model 401 from generation `g` cannot invalidate generation `g + 1`
- fresh usage avoids a probe
- usage at 60 seconds triggers one probe
- probe failure preserves the old observation timestamp
- no snapshot plus probe failure makes an account ineligible
- expired refresh claims can be recovered
- maintenance skips fresh accounts and repairs due accounts
- route acquisition returns lease plus the exact selected credential generation

Run:

```bash
bun test packages/codex/test/subscription-router.test.ts
```

Expected: module-not-found failure.

### Step 2: Implement storage operations and coordinator

`SubscriptionAccountStore` owns atomic intent-oriented operations, including:

```ts
readonly claim: (
  input: RefreshClaimRequest
) => Effect.Effect<Option.Option<RefreshClaim>, AccountStoreError>

readonly commitCredential: (
  input: CredentialCommit
) => Effect.Effect<boolean, AccountStoreError>

readonly commitUsage: (
  input: UsageCommit
) => Effect.Effect<boolean, AccountStoreError>

readonly acquire: (
  input: SubscriptionAcquireInput
) => Effect.Effect<RouteGrant, NoEligibleAccount | AccountStoreError>
```

Use `Deferred` or `FiberMap` for runtime-local single flight and persistent claims for
cross-runtime exclusion. Waiters use a bounded Effect schedule to re-read state. Every public
operation is a named `Effect.fn`.

### Step 3: Refactor the handler

Replace `AccountDirectory.candidates -> RoutingState.acquire -> AccountDirectory.credential` with
one `SubscriptionRouter.acquire`. Preserve renewal, response recording, release, and all stream
termination behavior. Pass credential generation to response recording.

### Step 4: Verify and commit

```bash
bun test packages/codex/test/subscription-router.test.ts packages/codex/test/handler.test.ts
bun run typecheck
git diff --check
git add packages/codex
git commit -m "feat(codex): coordinate generation-safe subscriptions"
```

## Task 4: Implement Bun Effect SQL storage and maintenance schedule

**Files:**

- Add dependency: `@effect/sql-sqlite-bun`
- Create: `packages/bun/src/sqlite-account-store.ts`
- Create: `packages/bun/src/migrations.ts`
- Create: `packages/bun/src/maintenance.ts`
- Create: `packages/bun/test/sqlite-account-store.test.ts`
- Create: `packages/bun/test/maintenance.test.ts`
- Modify: `packages/bun/src/application.ts`
- Modify: `packages/bun/src/layers.ts`
- Modify: `packages/bun/src/index.ts`
- Modify: `packages/bun/src/sqlite-routing-state.ts`
- Modify: `packages/bun/test/sqlite-routing-state.test.ts`
- Modify: `package.json`
- Modify: `packages/bun/package.json`
- Modify: `bun.lock`

### Step 1: Add aligned Effect SQL dependency

```bash
bun add --dev --exact @effect/sql-sqlite-bun@4.0.0-beta.102
bun add --cwd packages/bun --exact @effect/sql-sqlite-bun@4.0.0-beta.102
```

Verify every Effect package remains exactly aligned.

### Step 2: Write failing SQL tests

Using two SQLite client instances against one temporary database, cover:

- migrations are idempotent
- seed-if-absent never overwrites a newer generation or usage snapshot
- one refresh claim wins across instances
- a claim can be recovered after expiry
- credential and usage CAS reject stale generations
- route acquisition, selection, lease insertion, and credential read share one transaction
- removal cascades all account state
- summaries contain no credential/provider fields

Run:

```bash
bun test packages/bun/test/sqlite-account-store.test.ts
```

Expected: module-not-found failure.

### Step 3: Implement Effect SQL adapter

- Provide `SqlClient` with `@effect/sql-sqlite-bun`.
- Run ordered migrations through its migrator.
- Decode SQL rows with Schema.
- Use `sql.withTransaction` for state changes and acquisition.
- Fold the existing routing-state implementation into the new store; do not keep two independent
  transaction owners.

### Step 4: Write and implement schedule test

With `TestClock`, prove a scoped maintenance fiber runs once per minute and stops on scope close.
Implement it with `Schedule.spaced("1 minute")` or `Schedule.fixed("1 minute")`, not a manual
sleep loop.

### Step 5: Verify and commit

```bash
bun test packages/bun/test/sqlite-account-store.test.ts packages/bun/test/maintenance.test.ts packages/bun/test/sqlite-routing-state.test.ts
bun run typecheck
git diff --check
git add package.json packages/bun bun.lock
git commit -m "feat(bun): persist and maintain subscription accounts"
```

## Task 5: Add secure local and remote administration

**Files:**

- Create: `packages/codex/src/account-admin.ts`
- Create: `packages/codex/test/account-admin.test.ts`
- Create: `packages/bun/src/admin-cli.ts`
- Create: `packages/bun/src/admin-client.ts`
- Create: `packages/bun/test/admin-cli.test.ts`
- Create: `apps/server/src/admin.ts`
- Modify: `packages/bun/src/config.ts`
- Modify: `packages/bun/src/server.ts`
- Modify: `packages/bun/src/index.ts`
- Modify: `package.json`

### Step 1: Write failing admin tests

Cover:

- administration authenticates before body access
- client and admin tokens must differ
- device flow prints verification URI and user code but never token results
- upsert/reauth increments rather than resets generation
- list/status/enable/disable/remove output is sanitized
- remote client requires HTTPS except explicit loopback
- invalid JSON and oversized identifiers are schema failures

Run:

```bash
bun test packages/codex/test/account-admin.test.ts packages/bun/test/admin-cli.test.ts
```

Expected: module-not-found failures.

### Step 2: Implement admin service and CLI

Expose portable `AccountAdmin` methods and a Bun entrypoint:

```bash
bun run codex-router account login --id "${ROUTER_ACCOUNT_ID}" --remote "${ROUTER_URL}"
bun run codex-router account status --remote "${ROUTER_URL}"
bun run codex-router account enable --id "${ROUTER_ACCOUNT_ID}"
bun run codex-router account disable --id "${ROUTER_ACCOUNT_ID}"
bun run codex-router account remove --id "${ROUTER_ACCOUNT_ID}"
```

Support local SQLite by replacing `--remote` with `--database`. Do not persist completed OAuth
credentials in shell history, arguments, temporary files, or stdout.

### Step 3: Verify and commit

```bash
bun test packages/codex/test/account-admin.test.ts packages/bun/test/admin-cli.test.ts
bun run typecheck
git diff --check
git add packages apps package.json
git commit -m "feat: add secure subscription administration"
```

## Task 6: Upgrade Cloudflare encryption to a rotating keyring

**Files:**

- Modify: `packages/cloudflare/src/credential-cipher.ts`
- Modify: `packages/cloudflare/src/config.ts`
- Modify: `packages/cloudflare/test/credential-cipher.test.ts`
- Modify: `packages/cloudflare/test/worker.test.ts`

### Step 1: Write failing keyring tests

Cover:

- strict keyring Schema rejects missing current version, empty keys, duplicate/redefined versions,
  invalid base64url, and non-32-byte keys
- current key encrypts
- retained old key decrypts
- generation participates in AAD
- old-key read yields a migration envelope using a fresh nonce
- missing old key fails without leaking envelope/token values
- version counts do not expose ciphertext or account identity

Run:

```bash
bun test packages/cloudflare/test/credential-cipher.test.ts packages/cloudflare/test/worker.test.ts
```

Expected: failures because config accepts one key and AAD omits generation.

### Step 2: Implement keyring and migration

Replace `CODEX_ROUTER_CREDENTIAL_KEY` with `CODEX_ROUTER_CREDENTIAL_KEYS_JSON`. Decode the JSON with
Schema before importing keys. Keep the entire secret binding redacted. Add `decryptForUse` returning
the plaintext plus optional current-key migration envelope.

### Step 3: Verify and commit

```bash
bun test packages/cloudflare/test/credential-cipher.test.ts packages/cloudflare/test/worker.test.ts
bun run typecheck
git diff --check
git add packages/cloudflare
git commit -m "feat(cloudflare): support credential key rotation"
```

## Task 7: Replace the Durable Object vault with the fused subscription coordinator

**Files:**

- Create: `packages/cloudflare/src/durable-subscription-store.ts`
- Create: `packages/cloudflare/src/control-transport.ts`
- Create: `packages/cloudflare/test/durable-subscription-store.test.ts`
- Create: `packages/cloudflare/test/control-transport.test.ts`
- Modify: `packages/cloudflare/src/router-state-object.ts`
- Modify: `packages/cloudflare/src/durable-object-routing-state.ts`
- Delete: `packages/cloudflare/src/credential-vault.ts`
- Modify: `packages/cloudflare/src/application.ts`
- Modify: `packages/cloudflare/src/index.ts`

### Step 1: Write failing Durable Object RPC tests

Build a fake SQLite Durable Object storage boundary and cover:

- seed only when absent
- acquisition returns lease plus encrypted selected generation
- a normal response uses acquire/record/release and no credential/get
- no RPC payload contains a model body
- refresh/usage claims and commits are generation-safe
- old envelopes are lazily migrated
- maintenance sweep refreshes due accounts only
- account removal cascades state
- internal maintenance cannot be invoked through the public Worker route

Run:

```bash
bun test packages/cloudflare/test/durable-subscription-store.test.ts
```

Expected: module-not-found failure.

### Step 2: Implement control transport tests and adapter

Assert OAuth refresh goes directly to the authorization host and usage probes use the configured AI
Gateway custom-provider URL with:

- Run token
- payload logging disabled
- cache disabled
- maximum one attempt
- bounded non-sensitive metadata

Decode every upstream JSON response before the store uses it.

### Step 3: Implement object schema and endpoints

Upgrade the existing object in a backwards-compatible SQLite migration. Implement:

- `/route/acquire`
- `/route/renew`
- `/route/record-response`
- `/route/release`
- `/maintenance/sweep`
- authenticated internal `/admin/*`

Delete `/credential/get` and `/credential/put`. The object constructs one `ManagedRuntime` and
provides the portable coordinator with a Durable Object store and control transport.

### Step 4: Verify and commit

```bash
bun test packages/cloudflare/test/durable-subscription-store.test.ts packages/cloudflare/test/control-transport.test.ts
bun run typecheck
git diff --check
git add packages/cloudflare
git commit -m "feat(cloudflare): fuse subscription route coordination"
```

## Task 8: Wire Worker fetch, cron, administration, and AI Gateway

**Files:**

- Modify: `packages/cloudflare/src/application.ts`
- Modify: `packages/cloudflare/src/worker.ts`
- Modify: `packages/cloudflare/src/ai-gateway-transport.ts`
- Modify: `packages/cloudflare/test/worker.test.ts`
- Modify: `packages/cloudflare/test/ai-gateway-transport.test.ts`
- Modify: `apps/worker/src/index.ts`
- Modify: `apps/worker/wrangler.jsonc`

### Step 1: Write failing Worker tests

Cover:

- client auth before model body access
- admin auth before admin body access
- fetch acquisition decrypts the fused credential envelope
- model path performs exactly three normal object calls
- response record includes credential generation
- scheduled handler calls maintenance once with no public token/body
- scheduled promise is passed to `waitUntil`
- long streams renew no more often than every 40 seconds
- cold start seed cannot overwrite persisted credentials
- AI Gateway URL is the custom subscription provider
- cache, retries, and payload collection are disabled

Run:

```bash
bun test packages/cloudflare/test/worker.test.ts packages/cloudflare/test/ai-gateway-transport.test.ts
```

Expected: failures for separate credential lookup, missing admin handler, and missing scheduled
handler.

### Step 2: Implement Worker composition

- Decode environment once and cache `ManagedRuntime` by binding identity.
- Acquire route and decrypt envelope before building the upstream request.
- Keep the model body entirely in the Worker-to-AI-Gateway fetch.
- Add authenticated admin routing.
- Export a module `scheduled` handler.
- Add `triggers.crons: ["* * * * *"]` to Wrangler.
- Remove bootstrap overwrites; only call seed-if-absent.

### Step 3: Verify and commit

```bash
bun test packages/cloudflare/test/worker.test.ts packages/cloudflare/test/ai-gateway-transport.test.ts
bun run build:worker
git diff --check
git add packages/cloudflare apps/worker
git commit -m "feat(worker): add cron and fused subscription routing"
```

## Task 9: Update operations, security, architecture, and research

**Files:**

- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/architecture.md`
- Modify: `docs/operations.md`
- Modify: `docs/research.md`
- Modify: `docs/security.md`
- Create: `docs/canary.md`

### Step 1: Replace foundation-era limitations

Document verified behavior only:

- subscription-only product boundary
- device login and account administration
- generation-safe refresh and live usage
- Cron Trigger and Effect schedule roles
- request-time repair
- three normal Durable Object operations
- keyring rotation sequence
- backup and restore
- free-tier capacity implications
- AI Gateway logging retention/privacy
- deployment, rollback, and incident response

Remove stale instructions for bootstrap access tokens, manual usage snapshots, API-key mode, and
the separate credential-get RPC.

### Step 2: Add executable canary instructions

`docs/canary.md` must contain exact commands for:

- local gates
- Wrangler dry run
- secret creation without shell-history leakage
- account login
- synthetic deployed stream validation
- minimal real subscription validation
- AI Gateway log/privacy inspection
- rollback

No fake secrets, placeholder account IDs, or claims of results that have not yet been measured.

### Step 3: Validate docs and commit

```bash
rg -n "openai_api_key|API-key mode|bootstrap access|manual usage" README.md AGENTS.md docs
rg -n "T.O?DO|FIX.ME|YOUR_|example-secret" README.md AGENTS.md docs
bunx prettier --check README.md AGENTS.md docs
git diff --check
git add README.md AGENTS.md docs
git commit -m "docs: operate the subscription router"
```

The first search may contain only historical evidence explicitly labeled as removed. The second
must return no placeholders.

## Task 10: Local release verification

**Files:**

- Modify only files required by failures

### Step 1: Run focused security scans

```bash
rg -n "\bany\b|as unknown as|!\.|!\)|namespace " packages apps
rg -n "\.(text|json|arrayBuffer|clone|tee)\(" packages/codex/src/handler.ts packages/cloudflare/src
rg -n "authorization|refreshToken|providerAccountId" packages apps
rg -n "openai_api_key|api.openai.com/v1/responses" packages apps README.md AGENTS.md docs
git diff --check
```

Review every match; transport construction and redacted credential model references are allowed,
logging and model-body reads are not.

### Step 2: Run the complete gate

```bash
bun run check
```

Expected:

- format check passes
- lint passes with zero warnings
- typecheck passes
- all tests pass
- Wrangler dry-run builds

### Step 3: Commit gate-only repairs

If needed:

```bash
git status --short
git add packages apps package.json bun.lock
git commit -m "fix: pass subscription release gates"
```

Stage only repaired paths shown by `git status`; omit unchanged paths and do not create an empty
commit.

## Task 11: Provision and validate Cloudflare

**Files:**

- Create: `scripts/synthetic-canary.ts`
- Create: `scripts/inspect-ai-gateway.ts`
- Modify: `package.json`
- Modify: `docs/canary.md`
- Modify: `docs/operations.md`

### Step 1: Add a synthetic canary test first

Create a testable canary module whose fixture stream includes delayed SSE chunks and byte-sensitive
UTF-8 boundaries. Unit-test:

- exact byte equality
- first-byte timing captured separately from completion
- one request only
- no credential/payload printing

### Step 2: Provision secrets and deploy

Using Cloudflare's authenticated CLI/API:

- create or select the dedicated AI Gateway/custom provider
- generate client/admin tokens locally without printing them
- generate a versioned AES-256 keyring without printing it
- write secrets through stdin
- deploy the saved Worker configuration
- record the deployment identifier and settings without recording secret values

Never place secret values in command arguments, files, process listings, commentary, commits, or
logs.

### Step 3: Run synthetic deployed canary

Run the synthetic stream through the deployed Worker and AI Gateway. Record:

- exact bytes
- time to first byte
- total duration
- Worker CPU from Cloudflare telemetry
- Durable Object request count
- AI Gateway log presence
- payload absence

If Cloudflare configuration buffers or retries, fix configuration/code, add a regression test, and
repeat.

### Step 4: Commit measured canary tooling/docs

```bash
bun test scripts
bun run check
git diff --check
git add scripts package.json docs/canary.md docs/operations.md
git commit -m "test: add deployed streaming canaries"
```

## Task 12: Authorize one account and run the real canary

**Files:**

- Modify: `docs/canary.md`
- Modify: `docs/operations.md`

### Step 1: Start device authorization

```bash
bun run codex-router account login --id "${ROUTER_ACCOUNT_ID}" --remote "${ROUTER_URL}"
```

The human must complete the displayed OpenAI device authorization. This is the only unavoidable
interactive step. Do not import browser cookies or copy local account files without an explicit
operator action.

### Step 2: Run one minimal subscription request

Send one minimal streaming Codex Responses request through the deployed Worker. Do not retry.
Verify:

- one model request
- live usage timestamp
- account selected and released
- response completion
- AI Gateway metadata visibility
- no stored prompt/response payload
- no credential-shaped Worker log field

### Step 3: Exercise generation safety

Reauthenticate the same opaque account and verify its generation increments. Confirm a simulated
late 401 for the old generation cannot mark the new generation as requiring reauthentication.
Do not force-expire or revoke a healthy production credential merely to test refresh.

### Step 4: Record measured results and commit

Document date, route shape, status, byte/stream result, counts, and privacy inspection without
request content, model output, provider identity, or credential material.

```bash
bun run check
git diff --check
git add docs/canary.md docs/operations.md
git commit -m "docs: record subscription canary verification"
```

## Task 13: Push and verify main

### Step 1: Inspect the complete branch

```bash
git status --short --branch
git log --oneline origin/main..main
git diff --stat origin/main...main
git diff --check origin/main...main
```

Review every changed file and confirm there are no unrelated user changes.

### Step 2: Run the final gate again

```bash
bun run check
```

### Step 3: Push authorized main

```bash
git push origin main
```

### Step 4: Verify remote and deployed health

```bash
git fetch origin main
test "$(git rev-parse main)" = "$(git rev-parse origin/main)"
git status --short --branch
```

Run one non-model health/status request against the deployment and inspect the most recent
Cloudflare deployment state. Do not send another paid/model request.

### Step 5: Complete the active goal

Mark the goal complete only when:

- all local release gates pass
- deployed synthetic and minimal real canaries pass
- docs contain measured results
- main is pushed and synchronized
- no required work remains
