# Subscription-Only Release Design

**Date:** 2026-07-30

**Status:** Approved for implementation

## Outcome

`codex-router` becomes a small, auditable load balancer for Codex traffic authenticated by ChatGPT
subscription OAuth credentials. It does not accept, store, route, or document OpenAI API keys.

The same portable Effect domain runs in two environments:

- Cloudflare Workers, with one SQLite Durable Object for strongly consistent coordination and
  Cloudflare AI Gateway for metadata-only request visibility.
- Bun on a VM or in Kubernetes, with Effect SQL over a native SQLite database.

AgentOS can consume the portable packages without importing Cloudflare, Bun, filesystem, or
Kubernetes concerns.

The release is complete only after OAuth acquisition and refresh, live quota refresh, account
administration, encryption-key rotation, scheduled maintenance, byte-preserving streaming, and
deployed canaries are verified.

## Product Boundary

The router is deliberately subscription-only. The prior `openai_api_key` account kind, API-key
configuration, API upstream mapping, and mode-selection branches are removed.

The supported incoming paths are:

- `/responses`
- `/v1/responses`
- `/codex/responses`
- `/responses/compact`
- `/v1/responses/compact`

All of them forward to the corresponding Codex subscription endpoint under
`https://chatgpt.com/backend-api/codex`.

This is an account-health and quota router, not a semantic model router. It does not read prompts,
select models, replay requests, or inspect response content. OpenAI does not document multi-account
ChatGPT OAuth pooling as a public API product, so the documentation must keep the integration's
experimental status and terms/privacy review requirement explicit.

## Architectural Decisions

### Portable domain, runtime adapters

Portable packages own all business semantics:

- OAuth credential generations and identity invariants
- quota windows, freshness, and eligibility
- sticky selection and reservation policy
- acquisition, renewal, response recording, and release
- refresh and usage-cache orchestration
- typed errors and sanitized summaries

Runtime adapters own only:

- HTTP transport
- persistent storage
- encryption-key access
- process or platform scheduling
- runtime startup and shutdown

No portable package imports `bun:*`, Cloudflare types, Node built-ins, or Wrangler.

### Request-time correctness, scheduled optimization

Correctness cannot depend on a timer firing.

Every route acquisition atomically checks the selected account's persisted credential and usage
state. It refreshes an expiring credential, obtains live usage when the 60-second cache is stale,
and then selects and reserves an eligible account. A crashed process, delayed cron, or cold start
therefore heals on the next request.

Scheduled maintenance reduces hot-path latency:

- Cloudflare uses a Cron Trigger whose `scheduled()` handler asks the Durable Object to sweep
  accounts due for credential or usage refresh.
- Bun repeats the same portable sweep operation with an Effect `Schedule`.
- Both use jittered network retry policies and the same generation-safe commit rules.

Cloudflare Workflows are not used. Refresh and quota probes are short, bounded, idempotent
operations; Durable Object transactions already provide the required coordination.

### One coordinator, three normal Durable Object calls

The Durable Object owns centralized subscription state. A normal Worker request performs:

1. `route/acquire`, returning a lease and the selected encrypted credential envelope in one
   response.
2. `route/record-response`, classifying the upstream response against that credential generation.
3. `route/release`.

Long streams additionally renew no more often than every 40 seconds.

The model request and response bodies never enter the Durable Object. The Worker decrypts the
selected envelope in memory, injects it into the upstream request, and streams through Cloudflare AI
Gateway.

Fusing route acquisition with credential delivery removes the current fourth Durable Object call to
`credential/get`. At the observed peak of 24,657 requests/day, the normal path is 73,971 Durable
Object requests/day before stream renewals.

## Domain Model

### Opaque account identity

`AccountId` remains an operator-assigned opaque identifier. Provider account identity is sensitive
credential metadata and never appears in decisions, URLs, logs, summaries, or AI Gateway metadata.

### Credential bundle

A subscription credential bundle contains:

- access token
- refresh token
- access-token expiry timestamp
- verified provider account identity
- monotonically increasing credential generation

Access and refresh tokens use Effect `Redacted`. Provider identity is encrypted at rest with the
tokens. The generation is safe to expose internally and is used for compare-and-set behavior.

An access token is due for proactive refresh five minutes before expiry. Refresh responses must
decode through Effect Schema and must resolve to the same provider identity as the stored bundle. An
identity change fails closed and marks the account as requiring reauthentication.

### Usage snapshot

The existing two-window usage model remains:

- short-window remaining percentage
- weekly remaining percentage
- weekly reset timestamp
- observation timestamp

Usage is fresh for 60 seconds and usable as a penalized fallback for at most 24 hours. A stale
snapshot is not silently rewritten as fresh. Live usage is obtained from the authenticated Codex
usage endpoint and decoded at the HTTP boundary.

### Route grant

The portable acquisition result contains:

- lease token
- opaque account ID
- credential generation
- credential bundle at portable runtime boundaries
- assignment expiry
- lease expiry

The Cloudflare RPC representation replaces the plaintext credential bundle with an authenticated
encrypted envelope. Bun keeps credential material inside the same process and never serializes it
into routing summaries.

## Effect Services

The portable application is expressed through `Context.Service`, `Layer`, `Effect.fn`, Schema
classes, tagged errors, and `ManagedRuntime`.

### `OAuthClient`

- starts and polls the OpenAI device-code authorization flow
- refreshes a bundle with a refresh token
- validates the provider identity derived from returned tokens
- uses a bounded exponential, jittered Effect retry schedule only for retryable transport failures
- never retries identity failures or invalid-grant responses

### `UsageProbe`

- fetches current Codex subscription quota using the selected generation
- emits a schema-validated usage snapshot
- distinguishes authentication rejection, throttling, retryable transport failure, and invalid
  payload

### `SubscriptionAccountStore`

Provides atomic operations needed by the portable coordinator:

- seed an account only when absent
- create, replace, disable, remove, and summarize accounts
- claim and release a refresh lock
- read and compare credential generations
- commit a refreshed credential only when the claimed generation still matches
- mark reauthentication only when the rejected generation still matches
- read and commit usage snapshots
- atomically select and acquire a route
- renew, classify, record, and release a lease
- report encryption-key-version counts without exposing ciphertext

The storage port exposes business operations rather than raw SQL or Durable Object RPC concepts.

### `SubscriptionRouter`

Owns:

- single-flight refresh and usage checks
- route acquisition
- lease renewal
- response recording
- generation-safe rejection handling
- release
- scheduled maintenance sweeps

Runtime-local concurrent callers share one in-flight refresh or usage probe per account. The
persistent refresh claim supplies cross-process and cross-isolate exclusion.

### `AccountAdmin`

Owns:

- device login completion
- account upsert and reauthentication
- account disable/remove
- sanitized account status
- encryption-key migration status

It never returns access tokens, refresh tokens, provider identities, ciphertext, or nonces.

## Persistence and Concurrency

### Tables

Both SQLite implementations represent the same logical records:

`accounts`

- opaque account ID
- enabled flag
- reauthentication-required flag
- created and updated timestamps

`credentials`

- opaque account ID
- key version
- nonce
- ciphertext
- credential generation
- access-token expiry
- updated timestamp

`usage_snapshots`

- opaque account ID
- short and weekly remaining percentage
- weekly reset timestamp
- observed timestamp
- credential generation used by the probe

`refresh_claims`

- opaque account ID
- operation kind (`credential` or `usage`)
- random claim token
- claimed credential generation
- expiry timestamp

Existing assignment, reservation, and health tables remain.

Provider identity is part of encrypted credential plaintext, not a plaintext column. Account and
credential writes, refresh claims, usage commits, and route acquisition are transactional.

### Generation-safe refresh

Refresh follows this sequence:

1. Read generation `g`.
2. Atomically claim refresh for `(account, credential, g)` with a short expiry.
3. Decrypt the credential only after winning the claim.
4. Call OAuth refresh.
5. Verify provider identity.
6. Encrypt generation `g + 1`.
7. Commit only if the stored generation is still `g` and the claim token matches.
8. Release or expire the claim.

Losers re-read the newer bundle rather than refreshing again.

### Generation-safe usage

Usage probes use the same claim pattern. Their result is committed only if the account still has the
generation used for the probe. An older in-flight 401 can mark reauthentication only when that
generation is still current.

### Bootstrap behavior

Bootstrap configuration may seed an empty store. It must never overwrite an existing account,
credential, generation, refresh token, usage snapshot, or administrative state. Worker cold starts
therefore cannot restore stale bootstrap secrets over a refreshed credential.

## Cloudflare Design

### Bindings and secrets

The Worker uses:

- `ROUTER_STATE`: one SQLite Durable Object namespace, object name `global`
- `CODEX_ROUTER_CLIENT_TOKEN`: client authentication
- `CODEX_ROUTER_ADMIN_TOKEN`: distinct administration authentication
- `CODEX_ROUTER_CREDENTIAL_KEYS_JSON`: a keyring with current version and versioned AES-256 keys
- Cloudflare account, gateway, provider, and AI Gateway Run token bindings

Client and admin tokens must not be equal.

### Credential keyring and rotation

The keyring JSON has a current version and a non-empty mapping of immutable version names to
base64url-encoded 32-byte AES keys.

Encryption uses:

- AES-256-GCM
- a new random 96-bit nonce per encryption
- opaque account ID plus credential generation as additional authenticated data
- explicit key version in the envelope

Decryption accepts retained older key versions. Any successful read of an old envelope lazily
re-encrypts with the current key. An authenticated admin sweep can eagerly migrate all rows.
Operators may retire an old version only after the sanitized key-version counts report zero
remaining rows for it.

### Durable Object control-plane transport

The Durable Object performs OAuth refresh and usage probes because it owns the persistent refresh
claim and can complete the commit without another public RPC.

OAuth token refresh goes directly to OpenAI's authorization host. Usage probes may use Cloudflare AI
Gateway's custom-provider endpoint so control-plane request timing and status are visible without
payload logging. Neither call includes model bodies.

### Worker data-plane transport

The Worker:

1. authenticates and validates method/path before body access
2. acquires a route and encrypted credential
3. decrypts the credential in memory
4. strips caller credentials and hop-by-hop headers
5. adds the selected subscription authorization and provider-account header
6. adds Cloudflare AI Gateway Run authentication and privacy overrides
7. sends the model request exactly once
8. preserves status, safe headers, SSE ordering, and bytes
9. records the response against the selected generation
10. releases on every termination path

Every AI Gateway model request explicitly sets:

- `cf-aig-skip-cache: true`
- `cf-aig-collect-log-payload: false`
- `cf-aig-max-attempts: 1`

Metadata contains at most five bounded non-sensitive values. DLP and response buffering remain off.

### Scheduled handler

The module Worker exports `scheduled(controller, env, ctx)`. It authenticates no public request,
does not receive a model body, and calls the Durable Object's maintenance endpoint with an internal
binding capability. `ctx.waitUntil` keeps the bounded sweep alive.

The schedule is frequent enough to cover the five-minute credential lead and 60-second quota
freshness without causing synchronized account refreshes. Per-account jitter and claims prevent a
refresh stampede. The initial default is every minute; usage probes skip accounts whose snapshots
remain fresh.

## Bun and Kubernetes Design

The Bun runtime provides the same store with Effect SQL and native SQLite. Migrations run once at
startup. `BEGIN IMMEDIATE` or the Effect SQL transaction abstraction protects acquisition and
claims.

One process starts an Effect-scheduled maintenance fiber. It repeats the portable maintenance sweep
at a one-minute cadence, is scoped to application lifetime, and uses `TestClock` in tests.

One SQLite file on a Kubernetes PVC supports one writer replica. Multi-replica deployment requires a
database adapter that preserves the same transactional and claim semantics.

## Administration

### Authentication boundary

Public client routes and administration routes use distinct constant-time token checks. Both
authenticate before reading a body. Administration is unavailable when its secret is absent or
invalid.

### Bun CLI

The Bun CLI supports:

- device-code login and reauthentication
- list/status with sanitized fields
- disable/enable
- remove
- credential-key migration and version counts for a remote Worker
- local SQLite administration for a Bun deployment

The login flow prints only the user code and verification URL needed for the human authorization
step. It never prints returned tokens. Remote administration sends the completed credential bundle
over HTTPS to the Worker, which encrypts it immediately inside the Durable Object.

### Worker administration

Authenticated endpoints accept Schema-decoded bounded JSON and expose only sanitized results.
Account creation/re-authentication increments the generation rather than resetting it. Removing an
account also expires its assignments, reservations, claims, snapshots, and encrypted credential.

## Failure Semantics

- OAuth invalid grant: mark the matching generation as requiring reauthentication.
- Provider identity change: fail closed and require explicit reauthentication.
- Usage 401: reject only the generation used for that probe.
- Usage 429 or retryable failure with a prior snapshot: retain the old observation timestamp and
  permit only the existing stale-fallback policy.
- No snapshot and failed usage probe: account is ineligible.
- Model 401: mark only the route's credential generation.
- Model 429: apply quota cooldown using `Retry-After` only as response-health evidence.
- Model 403/404/5xx: preserve the current tested classification rules.
- Bookkeeping failure after an upstream response: log/measure it but return the real response.
- Transport failure before response: release and return a sanitized gateway error; never replay.
- Refresh claim owner crash: another caller may recover after claim expiry.
- Scheduled sweep failure: later schedule or request-time acquisition repairs it.

## Observability and Privacy

Meaningful business operations use named `Effect.fn` spans. Logs and span annotations may contain:

- opaque account ID
- credential generation
- operation kind
- freshness category
- response classification
- bounded timing and retry metadata

They never contain tokens, provider identities, headers, request/response bodies, encrypted
credential fields, device codes after the login interaction, or full upstream error payloads.

AI Gateway is used for request count, latency, status, and bounded metadata only. Stored payload
logging is disabled per request.

## Test Strategy

Tests are written before behavior and cover:

- subscription-only paths and removal of API-mode branches
- OAuth device and refresh decoding
- same-identity enforcement
- one five-minute-early refresh under concurrency
- cross-runtime refresh-claim recovery
- late 401 not invalidating a newer generation
- 60-second usage cache, stale fallback, and no-snapshot failure
- cron and Effect-schedule maintenance behavior with controlled clocks
- seed-if-absent cold starts
- atomic acquire returning the selected credential generation
- exactly three normal Durable Object RPCs
- keyring decoding, old-key decryption, lazy/eager migration, and safe retirement status
- admin auth before body access and sanitized output
- byte-identical SSE, empty streams, cancellation, transport failure, and long-stream renewal
- AI Gateway privacy, retry, and cache overrides
- SQLite visibility and transaction behavior
- Wrangler dry-run

## Deployment and Canaries

Deployment proceeds only after local gates pass.

### Synthetic canary

A controlled streaming origin returns deterministic SSE chunks with delays and binary-sensitive
boundaries. The deployed Worker path through Cloudflare AI Gateway must preserve:

- status and safe headers
- exact byte sequence
- chunk ordering
- time-to-first-byte behavior consistent with streaming
- one upstream request
- release and response recording

The AI Gateway dashboard/log API must show metadata while storing no prompt or response payload.
Measured Worker CPU and Durable Object operation counts are recorded rather than inferred from
bundle size.

### Minimal real subscription canary

After one account completes device authorization, send one minimal Codex Responses streaming request
through the deployed Worker and AI Gateway. Verify:

- live usage is obtained
- the account is selected
- the response stream completes
- response recording and release occur
- no credentials or payloads appear in logs

No browser cookie is imported, no hidden credential is copied silently, and no second request is
sent as an automatic retry.

## Release Gates

The release gate is:

```bash
bun run format:check
bun run lint
bun run typecheck
bun test
bun run build:worker
git diff --check
```

Additionally:

- no `openai_api_key` or API-mode behavior remains
- no `TODO`, `FIXME`, fake secret, placeholder account, unchecked cast, `any`, non-null assertion,
  model-body read, or credential-shaped log remains
- local Bun maintenance and storage tests pass
- Wrangler dry-run passes
- deployed synthetic canary passes
- minimal real subscription canary passes
- Cloudflare settings and log privacy are inspected
- documentation matches the verified behavior and current external limits
- verified changes are pushed directly to `main`
