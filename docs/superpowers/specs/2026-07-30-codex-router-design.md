# Codex Router Design

**Status:** Approved on 2026-07-30

**Repository:** `akua-dev/codex-router`

## Purpose

Codex Router is an efficient multi-account load balancer for Codex and
ChatGPT-backed coding agents. It selects a usable account from real short and
weekly quota windows, preserves session affinity, coordinates concurrent work,
and forwards native Responses API traffic without changing its semantics.

The router has two first-class deployment targets:

- Cloudflare Workers, using a SQLite Durable Object for strongly consistent
  routing state and Cloudflare AI Gateway for metadata-only request visibility.
- Bun in a Kubernetes Pod, VM, or local process, using the same portable core
  with a SQLite persistence adapter.

The portable packages must be directly reusable by the existing AgentOS
`services/ai-gateway` package. Cloudflare is an adapter, not the architecture.

## Scope

The initial repository establishes a working, tested vertical foundation:

- Effect-first domain types, errors, services, layers, and business operations.
- Codex quota parsing, deterministic account selection, error classification,
  request path handling, header sanitation, and session-key extraction.
- A portable request handler expressed in Web Platform `Request`, `Response`,
  `Headers`, `ReadableStream`, `AbortSignal`, and Web Crypto concepts.
- A Cloudflare Worker entrypoint and SQLite Durable Object state adapter.
- A Bun server entrypoint and SQLite state adapter.
- Transparent response streaming through a selected upstream.
- Cloudflare AI Gateway request construction with caching and payload logging
  disabled by default.
- Official Effect agent guidance and locally searchable Effect source.
- Documentation for security, operations, architecture, research evidence,
  compatibility risks, and future protocol milestones.

The initial repository does not claim transparent Responses WebSocket support.
HTTP and SSE are the released transport. WebSocket support requires its own
protocol tests because Cloudflare AI Gateway's WebSocket API is not a
transparent Responses WebSocket bridge.

## Architectural Approaches Considered

### 1. Effect workspace with portable core and runtime adapters

This is the selected design. Each runtime depends inward on platform-neutral
packages. AgentOS can reuse the core without importing Cloudflare modules.

Benefits:

- Runtime-specific state and server APIs cannot leak into routing policy.
- Cloudflare and Bun implementations share contract tests.
- The protocol adapter can evolve independently from persistence.
- Effect services and layers make runtime substitutions explicit and testable.

Cost:

- More package boundaries and initial workspace configuration.

### 2. Single package with conditional exports

This reduces initial files but makes Cloudflare, Bun, persistence, and protocol
concerns easy to mix. Conditional exports do not enforce architectural
separation. It was rejected because AgentOS reuse is a primary requirement.

### 3. Worker-only router followed by later extraction

This is the shortest path to a canary but would encourage Durable Object
assumptions inside domain logic and duplicate the existing AgentOS selection
behavior. It was rejected because extraction would be predictable rework.

## Repository Layout

```text
apps/
  server/                   Bun executable composition root
  worker/                   Cloudflare Worker composition root
packages/
  core/                     Effect domain, ports, policies, handler
  codex/                    Codex protocol and ChatGPT-account adapter
  cloudflare/               Worker, Durable Object, AI Gateway adapters
  bun/                      Bun server and SQLite adapters
.agents/skills/effect-ts/   Vendored official Effect skill
.repos/effect/              Pinned Effect source submodule
docs/
  architecture.md
  operations.md
  research.md
  security.md
  superpowers/
    specs/
    plans/
```

Every package exports a deliberately small public surface. Runtime composition
roots may import portable packages and their own adapter package. Portable
packages may not import from `cloudflare:*`, `bun:*`, Node built-ins, Wrangler,
or runtime-specific package paths.

## Technology Baseline

- Runtime and package manager: Bun 1.4 or newer.
- Language: TypeScript in strict mode with no `any`, casts, namespaces, or
  unchecked external input.
- Effect: the exact `effect@beta` version resolved at installation time,
  currently the Effect v4 beta required by the official Effect skill.
- Effect companion packages: exact, mutually aligned beta versions.
- Tests: `@effect/vitest` with Vitest and Effect test services.
- Worker tooling: current Wrangler with `compatibility_flags = ["nodejs_compat"]`
  only when a verified dependency requires it.
- Persistence: SQLite in Durable Objects and Bun. The storage port remains
  independent of SQL and runtime APIs.

The official Effect skill is vendored from `Effect-TS/skills` with its source
commit recorded. The Effect repository is a pinned Git submodule at
`.repos/effect`, satisfying the official skill's source-research prerequisite.

## Effect Architecture

All application behavior is modeled as `Effect<A, E, R>`.

Named reusable operations use `Effect.fn`. Inline orchestration uses
`Effect.gen`. External input is decoded through `Schema`. Expected failures use
`Schema.TaggedErrorClass`. Services use `Context.Service`; implementations use
named `Layer` values. Layers are fully composed at each runtime boundary, and
`ManagedRuntime` bridges the Effect graph to Worker and Bun fetch handlers.

Initial service ports:

- `RoutingState`: acquire, renew, release, block, and summarize routes.
- `AccountDirectory`: list opaque account summaries and obtain a credential
  reference for a selected account.
- `UsageProbe`: return fresh or explicitly stale quota snapshots.
- `CredentialCipher`: encrypt and decrypt account credential bundles.
- `UpstreamTransport`: perform one outbound request and return the real
  response.
- `GatewayTelemetry`: create safe, bounded metadata without payloads.
- `IdGenerator`: create opaque account and lease identifiers.

Business operations:

- `selectAccount`: pure deterministic policy over validated candidates.
- `acquireRoute`: atomically combine assignment cleanup, block cleanup,
  selection, lease creation, and optional session assignment.
- `classifyUpstreamResponse`: map a response to routing bookkeeping without
  replacing the response.
- `routeRequest`: authenticate, validate path, acquire a route, sanitize
  headers, forward once, record response state, and release on body completion
  or cancellation.

Layer provisioning occurs once in each composition root. Tests use
`@effect/vitest` layers rather than local `Effect.provide` calls.

## Domain Model

All identifiers are schema-backed branded strings:

- `AccountId`: router-owned opaque account identifier.
- `ProviderAccountId`: provider identity that must remain secret.
- `SessionKey`: explicit caller session identifier, bounded to 256 characters.
- `LeaseToken`: unguessable reservation identifier.

Quota data:

- `UsageWindow`: used percentage and optional reset timestamp.
- `UsageSnapshot`: account, observation time, short window, weekly window,
  stale marker, optional plan type, and optional credits.
- `Candidate`: opaque account label, usage snapshot, reauthentication state,
  active block, and active reservation count.

Routing data:

- `SessionAssignment`: session-to-account mapping with update time.
- `Reservation`: account lease with creation and expiry.
- `AccountBlock`: quota or transient cooldown with an optional retry time.
- `SelectionDecision`: selected account, stable reason code, and safe candidate
  explanations.

Credential bundles never appear in routing data, explanations, telemetry,
errors, status payloads, or log annotations.

## Selection Policy

The policy carries forward the tested AgentOS semantics:

1. Reject accounts requiring reauthentication.
2. Reject active blocks.
3. Reject missing usage data when another usable account exists.
4. Reject quota snapshots older than the maximum safe age.
5. Reject a weekly window with no future reset.
6. Apply a penalty to stale but still usable data.
7. Enforce configurable short-window and weekly-window headroom.
8. Prefer weekly quota that is at greatest risk of expiring unused, expressed
   as remaining quota divided by hours until reset.
9. Keep the current session account when it remains within the configured
   hysteresis band.
10. Break ties deterministically using weekly remaining quota, short-window
    headroom, active reservation count, and opaque account ID.

Selection never round-robins individual requests. Session affinity is preserved
until the assigned account is genuinely ineligible.

## Request Data Flow

```text
client
  -> runtime fetch adapter
  -> authenticate without consuming the body
  -> validate POST path
  -> extract explicit session key
  -> RoutingState.acquire
  -> AccountDirectory credential lookup
  -> sanitize caller headers
  -> inject selected upstream authorization
  -> optional AI Gateway provider-specific endpoint
  -> ChatGPT Codex or OpenAI Responses upstream
  -> return status, headers, and body stream
  -> release lease on close, cancel, or transport failure
```

Supported incoming paths:

- `/responses`
- `/v1/responses`
- `/codex/responses`
- `/responses/compact`
- `/v1/responses/compact`

Codex subscription requests are normalized to
`https://chatgpt.com/backend-api/codex/responses`. Standard API-key requests
are normalized to `https://api.openai.com/v1/responses` or
`/v1/responses/compact`.

Codex native remote compaction may arrive at `/codex/responses` with a
`compaction_trigger`; the body is forwarded opaquely. The router does not parse
or persist prompts, tool calls, encrypted reasoning, compaction artifacts, or
model output.

## Streaming Contract

The response body is never converted with `text()`, `json()`, or a buffering
clone. A small wrapper releases the route lease when the upstream stream ends
or is cancelled. Status, status text, SSE event order, bytes, and safe upstream
headers are preserved.

Hop-by-hop and stale representation headers are removed when the runtime may
have decoded the body:

- `connection`
- `content-encoding`
- `content-length`
- `proxy-authenticate`
- `te`
- `trailer`
- `transfer-encoding`
- `upgrade`

The router does not replay a request after upstream transmission. A stream
failure after output begins could otherwise duplicate model work or tool side
effects. The caller harness owns recovery.

## Error and Cooldown Semantics

- Invalid client authentication: `401` generated before body access.
- Unsupported method or path: `404`.
- No eligible account: `503` with a small router-owned error body.
- Credential unavailable before transmission: typed router failure translated
  at the HTTP boundary.
- Transport failure before an upstream response: release the lease and expose a
  typed gateway failure.
- `401` upstream: mark the exact credential generation rejected and require
  reauthentication when still current.
- `429` upstream: block the account until parsed reset or `Retry-After`, falling
  back to a short conservative cooldown.
- `403`: preserve as workspace, configuration, or origin-protection evidence;
  do not label it quota automatically.
- `404`: preserve as model or account availability evidence.
- `5xx`: preserve as transient upstream failure.
- Incomplete or disconnected stream: release the lease; never report success
  or silently replay it.

Bookkeeping failures are logged safely and must never replace the real upstream
response.

## Cloudflare Runtime

The Worker performs client authentication, route acquisition, credential
injection, and direct streaming.

A SQLite Durable Object owns:

- account health and quota snapshots
- session assignments
- renewable leases
- cooldowns
- token-refresh coordination
- schema migrations

The Durable Object is called only for short state transitions. It never proxies
or consumes the upstream stream. Workers KV is forbidden for routing state
because it is eventually consistent, lacks the needed atomic operations, and
can overwrite concurrent writes.

Credential bundles stored by Cloudflare are encrypted with AES-GCM. A versioned
key-encryption secret is supplied as a Worker secret. The database contains
only ciphertext, nonce, key version, and non-sensitive lifecycle metadata.

The selected request goes through an AI Gateway provider-specific custom
endpoint when configured. The Worker adds:

- `cf-aig-skip-cache: true`
- `cf-aig-collect-log-payload: false`
- bounded metadata containing opaque account hash, decision reason, session
  hash, quota bucket, and runtime

The AI Gateway Run token remains a Worker secret. Clients never receive it.
Response DLP is disabled because it buffers the complete response. Custom
provider `/compat` and AI Gateway Dynamic Routing are not used for subscription
quota selection.

## Bun Runtime

The Bun application exposes the same fetch handler using `Bun.serve` at the
composition boundary.

The Bun SQLite adapter provides atomic transactions for assignments, leases,
blocks, quota snapshots, account metadata, and encrypted credentials. It works
on a Kubernetes PVC for the released single-replica topology. The portable
storage contract permits a later PostgreSQL adapter without changing routing or
protocol packages.

The Bun composition is directly usable by AgentOS:

- existing AgentOS OAuth and operator workflows may implement
  `AccountDirectory`
- existing locked-file state may be retained behind `RoutingState` during
  migration
- AgentOS Pi clients keep their native `/codex/responses` and compaction flow
- direct per-Agent authentication remains the recovery path

## Security Model

Trust boundaries:

- Client authentication protects every interface except `/healthz`.
- `/readyz` reveals only readiness.
- `/status` requires client authentication and returns opaque identifiers.
- Provider access tokens and account IDs exist only inside the selected
  transport operation.
- Refresh tokens are encrypted at rest and redacted in memory representations.
- Prompt and response payloads are never stored or logged.
- Full upstream error bodies are never copied into router logs.

Personal ChatGPT subscription OAuth is not a documented public multi-account
gateway contract. The adapter is explicitly experimental and isolated.
Compatibility can change without notice, accounts may require reauthentication,
and operators must confirm their entitlement and applicable terms. Standard
OpenAI API-key and enterprise access paths remain separate provider modes.

## Observability

Effect operations provide named spans and structured metrics at meaningful
boundaries:

- requests accepted, completed, cancelled, and failed
- route acquisitions and no-eligible-account outcomes
- selected reason codes
- usage-probe outcomes and staleness
- upstream status classes
- lease age and active reservation counts
- credential refresh outcomes without token or account detail

Attributes use opaque hashes and bounded enums. Prompts, model responses,
authorization values, cookies, provider account IDs, email addresses, and full
URLs with query strings are forbidden.

The Bun runtime may export Effect telemetry through OTLP. The Worker runtime
keeps instrumentation lightweight enough for the Free CPU budget and uses AI
Gateway metadata for request-level visibility.

## Validated Capacity Baseline

The July 30, 2026 retained-data audit inferred completed upstream model calls,
not human prompts:

| Source | Coverage | Calls |
| --- | ---: | ---: |
| Local Codex | 8,028 rollouts, Feb 2–Jul 30 | 570,364 |
| Remote AgentOS live homes | Jul 21–30 | approximately 15,219 |
| Local OrbStack AgentOS | retained Pi history | 1,349 |
| Known combined | retained readable data | approximately 586,932 |

Local Codex contained 1,993,486 raw completion records. Deduplication removed
histories copied into forks and resumed sessions.

The combined number is a lower bound. Twenty remote AgentOS StatefulSets were
scaled to zero with bound 20 GiB PVCs that were not mounted, so their old
histories were not counted. No matching rollout filenames were found between
the inspected local and remote Codex stores.

Observed traffic:

- Last nine complete UTC days: 105,034 calls.
- Recent average: 11,670 calls per day.
- Highest observed day: 24,657.
- Highest observed minute: 117.
- Highest observed second: 9.
- Remote cluster peak: approximately 3,249 per day.
- Existing AgentOS gateway: two Codex accounts and 69 sticky assignments.

At that traffic shape, one Worker request per call consumes 24.7% of the
100,000-request Free daily allowance at the observed peak. Two Worker
invocations consume 49.3%. Two short Durable Object operations also remain
under the observed request scale. The practical Worker risk is the 10 ms Free
CPU budget, so proxy work must stay small and bodies must stream unchanged.

AI Gateway's 100,000 stored-log Free allowance fills in approximately 8.6 days
at the recent average even though ingestion capacity is ample. Automatic oldest
log deletion or paid retention is required.

These figures are capacity-planning evidence, not permanent Cloudflare product
contracts. Operations documentation must link the current official limits and
require revalidation before production rollout.

## Existing-System Learnings

The AgentOS gateway demonstrates:

- authenticate before body access
- strip caller provider credentials
- explicit session keys rather than IP or user-agent inference
- deterministic selection with quota headroom and reset urgency
- a 60-second usage cache
- renewable leases released on close, cancel, and error
- atomic private state with strict validation
- access-token-generation checks before marking reauthentication
- real upstream response wins over local bookkeeping failures
- no transcript capture

The Pi remote-compaction extension demonstrates:

- ChatGPT Codex compaction uses the normal Codex Responses endpoint with a
  `compaction_trigger`, SSE, `remote_compaction_v2`, and encrypted content
- standard OpenAI uses `/responses/compact` and JSON
- session ID also acts as prompt-cache key and request correlation
- an incomplete stream must never create canonical persisted compaction state
- terminal status and exactly one canonical compaction artifact are validated
- portable local summary remains the recovery path when native remote
  compaction fails

The mature `codex-lb` project demonstrates that most complexity is evolving
Codex protocol compatibility: stream reconnects, compaction continuity, stale
usage, invalid tokens, prompt-cache locality, and WebSockets. These remain
explicit compatibility tests and milestones rather than assumptions.

Cloudflare and community deployments demonstrate that lightweight LLM routing
on Workers is viable. Known traps include Miniflare/deployed streaming
differences, compressed-response buffering, response DLP buffering, partial
Node compatibility, account-scoped AI Gateway Run tokens, and reports of
instability around `/compat` and Dynamic Routing. The selected design avoids
those paths.

## Testing Strategy

All behavioral implementation follows red-green-refactor.

Core tests:

- schema decoding rejects invalid external and persisted data
- selection covers health, freshness, headroom, urgency, hysteresis,
  reservations, stickiness, and deterministic ties
- upstream status classification covers `401`, `403`, `404`, `429`, `5xx`,
  `Retry-After`, and reset timestamps
- route acquisition is atomic under concurrent calls

Protocol tests:

- authentication happens before request-body pull
- every supported path maps to the correct upstream
- provider credentials are stripped and replaced
- session headers are bounded and explicit
- response bytes and safe headers are preserved
- lease release occurs on empty response, completion, cancellation, and
  transport failure
- local bookkeeping failure does not replace upstream output
- native compaction payloads pass unchanged

Runtime contract tests:

- the same routing-state contract runs against the in-memory, Bun SQLite, and
  Durable Object implementations
- the same fetch-handler suite runs against both composition roots
- Worker bindings decode through schemas
- Bun environment and database configuration decode through schemas

Verification:

- `bun test`
- TypeScript no-emit check
- formatting and lint checks
- Bun server smoke request
- Wrangler deployment dry-run
- package-boundary import check
- secret and placeholder scans

Miniflare is not sufficient evidence for response streaming. A later canary
milestone must test one account and one Pi agent against a deployed Worker for
24 hours before production routing.

## Delivery

Development proceeds directly on `main` because the repository is new and the
user explicitly authorized repeated pushes to `main`.

Initial commits:

1. Approved design specification.
2. Implementation plan and repository foundation.
3. Portable core and tests.
4. Cloudflare and Bun adapters with contract tests.
5. Project instructions and operator documentation.
6. Verification fixes and published repository state.

Every push follows fresh tests, type checking, builds, and a requirement audit.
