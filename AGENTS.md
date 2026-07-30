# codex-router agent instructions

This file is the authoritative project brief and engineering contract. Read it before changing code,
configuration, tests, operations, or documentation.

## Mission

Build a small, auditable, quota-aware router for Codex Responses traffic. It selects a usable
account from real short and weekly quota windows, keeps a session on one account while that account
remains safe, forwards the request exactly once, and preserves the upstream response stream.

The same portable Effect domain must run in:

- Cloudflare Workers, with a SQLite Durable Object for coordination and a provider-specific
  Cloudflare AI Gateway endpoint for metadata-only request visibility.
- Bun on a VM or in Kubernetes, with native SQLite on a persistent volume.
- AgentOS, by reusing `packages/core` and `packages/codex` rather than copying their policies.

This is a quota and account-health router, not a semantic model router. It does not inspect prompts
to decide which model is “best.” Cloudflare AI Gateway is the observability hop, not the source of
truth for subscription quota or sticky assignment state.

## Product boundary and honesty requirement

OpenAI documents Codex access through ChatGPT plans, but it does not document multi-user ChatGPT
OAuth pooling as a supported public API product. OpenAI also states that ChatGPT and API billing are
separate. This project is intentionally a ChatGPT subscription router, not an OpenAI API router.
Therefore:

- ChatGPT subscription routing is experimental and requires an explicit terms, privacy, and
  organizational-policy review before real use.
- Never invent or document a “Codex subscription API key.” No such public credential type is
  documented.
- Do not add OpenAI API-key accounts, API billing, or API upstream routing.
- Never claim that Cloudflare AI Gateway can consume a ChatGPT subscription directly. Its official
  Codex integration uses its OpenAI endpoint and Cloudflare-managed or provider credentials.
- Never claim production readiness while OAuth acquisition/refresh, live quota refresh, deployed
  stream canaries, and terms review remain incomplete.

The current repository is a tested foundation. It accepts bootstrap usage snapshots and credential
material through secret configuration, routes HTTP/SSE Responses traffic, persists routing state,
and encrypts the Worker credential vault. It does not yet implement the full AgentOS OAuth refresh
lock and live 60-second quota cache. Those are release blockers, not optional polish.

## Repository map and dependency direction

```text
packages/core
  schema-backed domain, deterministic selection, routing-state port,
  upstream response classification, in-memory test implementation

packages/codex
  Codex usage decoding, protocol paths, session extraction, header sanitation,
  service ports, one-shot transparent HTTP/SSE handler

packages/bun
  Bun config, native SQLite RoutingState, runtime layers, ManagedRuntime,
  health/status wrapper and Bun.serve boundary

packages/cloudflare
  Worker config, AES-GCM credential cipher, encrypted DO vault, DO client,
  SQLite Durable Object, AI Gateway transport, Worker ManagedRuntime

apps/server
  Bun composition root

apps/worker
  Cloudflare module Worker and Wrangler configuration
```

Dependency flow is one way:

```text
core <- codex <- bun app
              <- cloudflare app
```

`packages/core` and `packages/codex` must not import `bun:*`, `cloudflare:*`, Node built-ins,
Wrangler, or runtime-specific packages. Runtime APIs belong only in their adapter package or app.

## Effect engineering contract

Use the vendored official Effect skill at `.agents/skills/effect-ts/SKILL.md` for every Effect
change. It was copied from `Effect-TS/skills` at source commit
`a8b6bb40d1d4d550b49c0ff7a624b5e6da500a24`. The Effect source is pinned in `.repos/effect` at
`acee26944bc89ee554d7b9fadab7443f9edc28a9`; read source there when an API is unclear.

Required rules:

- Stay on the latest mutually aligned Effect beta versions. `effect`, `@effect/vitest`, and
  `@effect/platform-bun` must use the exact same version.
- Model application behavior as `Effect<A, E, R>`.
- Use `Effect.fn("stableName")` for reusable operations and `Effect.gen` for orchestration.
- Use `Context.Service` for ports and named `Layer` values for implementations.
- Build layers once with `ManagedRuntime` at Worker and Bun boundaries.
- Decode every external value with `Schema`, including environment, JSON, SQL rows, RPC payloads,
  usage responses, and encrypted envelopes.
- Use `Schema.Class` for persisted or transmitted domain models and `Schema.TaggedErrorClass` for
  expected errors.
- Use `Redacted` for credentials and secret bindings.
- Test Effects with `@effect/vitest`; share test dependencies through layers.
- Do not use `any`, unchecked casts, non-null assertions, namespaces, raw property probing on
  `unknown`, or ad hoc thrown exceptions for expected failures.
- Do not scatter `Effect.provide` through business functions. Provision at composition or test
  boundaries.

## Protocol and streaming contract

Supported incoming POST paths:

- `/responses`
- `/v1/responses`
- `/codex/responses`
- `/responses/compact`
- `/v1/responses/compact`

All model traffic maps to `https://chatgpt.com/backend-api/codex/responses`.

Native Codex remote compaction may arrive at `/codex/responses` with a `compaction_trigger`; forward
it opaquely. Do not parse or persist prompts, input items, tool calls, encrypted reasoning,
summaries, compaction artifacts, or model output.

Invariants:

1. Authenticate before touching the request body.
2. Validate method and path before route acquisition.
3. Use only explicit, non-empty session headers of at most 256 characters.
4. Acquire one route and one credential.
5. Strip caller provider credentials and hop-by-hop headers.
6. Inject only the selected upstream credential.
7. Transmit once. Never replay after transmission begins.
8. Never call `text()`, `json()`, `arrayBuffer()`, `clone()`, or `tee()` on a model request or
   response.
9. Preserve upstream status, status text, safe headers, SSE ordering, and bytes.
10. Release the lease on empty response, normal end, cancellation, stream error, or pre-response
    transport failure.
11. Renew a long stream no more often than once per 40 seconds. Never renew per chunk.
12. Bookkeeping failure must not replace a real upstream response.

Remove these response headers because runtimes may decode or reframe the stream: `connection`,
`content-encoding`, `content-length`, `proxy-authenticate`, `te`, `trailer`, `transfer-encoding`,
and `upgrade`.

HTTP only is the initial compatibility contract. Do not advertise WebSocket support until an
independent native Codex WebSocket protocol canary exists. AI Gateway’s WebSocket envelope is not
the same contract.

## Selection contract

Carry forward the tested AgentOS policy:

1. Reject reauthentication-required accounts.
2. Reject active quota or transient blocks.
3. Reject unknown usage.
4. Reject snapshots older than 24 hours.
5. Reject missing or elapsed weekly reset timestamps.
6. Treat data older than 60 seconds as stale, but usable only as a fallback tier.
7. Apply a five-percentage-point penalty to stale weekly headroom.
8. Require at least 10% short-window and 3% weekly remaining quota.
9. Compute expiry urgency as:

   ```text
   remaining weekly percent / max(0.25, hours until reset)
   ```

10. Prefer the greatest expiry urgency so quota at risk of expiring unused is consumed.
11. Keep the existing session account when it is within 10% of the best eligible score.
12. Break ties by weekly remaining quota, short-window remaining quota, active reservations, then
    opaque account ID.

Never round-robin individual requests. Session affinity protects prompt-cache locality and
multi-turn continuity. An anonymous request gets no inferred stickiness; never derive it from IP,
user agent, prompt content, or credentials.

## State contract

Atomic acquisition performs expiry cleanup, health overlay, selection, lease insertion, and optional
assignment upsert in one transaction.

- Assignment TTL: seven days.
- Lease TTL: 120 seconds.
- Stream renewal interval: 40 seconds.
- Usage freshness: 60 seconds.
- Maximum usage age: 24 hours.

Cloudflare uses one SQLite Durable Object named `global`. The public Worker may send only small
state or encrypted-vault RPC payloads to it. Model request and response bodies must never enter the
Durable Object. The object must not perform the model fetch or hold a stream open.

Bun uses SQLite `BEGIN IMMEDIATE`. A SQLite file on a Kubernetes PVC defaults to one replica.
Multi-replica Bun requires a storage design that provides the same transaction semantics; do not
mount one ordinary SQLite PVC read-write from multiple replicas.

Workers KV is forbidden for leases, assignments, quota blocks, refresh locks, or credentials.
Eventual consistency and missing atomic compare/update semantics make it unsafe for routing state.

## Credential and privacy contract

- Credential bundles never appear in candidates, decisions, summaries, errors, telemetry, URLs,
  response headers, or logs.
- Cloudflare persists credential bundles only as AES-256-GCM ciphertext.
- Use a 96-bit random nonce, explicit key version, and opaque account ID as additional authenticated
  data.
- Rotate by adding a new version, making it current, re-encrypting, verifying, then retiring the
  prior version. Never silently reuse a version with different key bytes.
- The Cloudflare AI Gateway Run token stays in the Worker and is added only as
  `cf-aig-authorization`.
- Always send `cf-aig-skip-cache: true`, `cf-aig-collect-log-payload: false`, and
  `cf-aig-max-attempts: 1`.
- AI Gateway metadata is limited to five bounded, non-sensitive values.
- Response DLP is off because it buffers the whole response. Request DLP is also off by default
  because this proxy’s primary privacy rule is not to inspect model payloads.
- Do not use AI Gateway `/compat` or Dynamic Routing for subscription account selection.
- Do not log full headers. `authorization`, `api-key`, `x-api-key`, `chatgpt-account-id`, refresh
  material, cookies, and account-provider identities are sensitive.
- Status surfaces expose only opaque account IDs, block categories, reauthentication booleans,
  assignment counts, and reservation counts.

## Observed request-volume baseline

This lower-bound audit was reconstructed on 2026-07-30 from local Codex rollout JSONL and live
AgentOS homes. Preserve these numbers in capacity discussions until a newer reproducible audit
supersedes them:

- Local Codex: 8,028 rollout files from February 2 through July 30.
- Raw local completion/token records: 1,993,486.
- Inferred distinct completed local model calls after fork/resume deduplication: 570,364.
- Remote live AgentOS homes, July 21–30: about 15,219 calls.
- Local OrbStack AgentOS: 1,349 calls.
- Known combined lower bound: about 586,932 calls.
- Twenty scaled-to-zero remote AgentOS StatefulSets still have bound 20 GiB PVCs that were not
  mounted for the audit, so they remain uncounted.
- No matching rollout filenames were found between the audited local and remote sets.
- Last nine complete UTC days: 105,034 calls.
- Recent average: 11,670 calls/day.
- Observed peak: 24,657 calls/day, 117/minute, and 9/second.
- Remote-cluster peak: about 3,249 calls/day.
- The inspected AgentOS gateway had two accounts and 69 sticky assignments.

At the observed peak:

- One Worker invocation per call is 24.657% of the Workers Free 100,000/day request allowance.
- Three normal Durable Object operations per completed call—acquire, record, release—are about
  73,971/day, 73.971% of the DO Free request allowance.
- A response lasting over 40 seconds adds renewals and can cross the DO Free allowance. Measure
  long-stream frequency before treating Free as guaranteed.
- AI Gateway’s 500 logs/second ingress limit is far above the observed 9/second peak.
- AI Gateway’s 100,000 stored-log Free allowance fills in about 8.6 days at 11,670/day unless
  auto-delete or export is configured.

Worker Free CPU is the tighter uncertainty: 10 ms per invocation. The current dry-run bundle is
about 1.1 MiB uncompressed and 227 KiB gzip, but bundle size does not prove CPU fit. A deployed
canary must measure startup and CPU. Keep the hot path opaque and avoid schema-decoding the model
body.

## AgentOS and Pi evidence to preserve

The design was derived from `/Users/robin/Developer/cnap-tech/agentos`:

- AgentOS already uses 60-second quota freshness, 120-second leases, seven-day assignments, 10%
  hysteresis, 10% short-window headroom, 3% weekly headroom, 24-hour maximum stale age, and a
  five-point stale penalty.
- Its vault uses private directories/files, atomic JSON replacement, refresh locks, rejected-token
  generation checks, and provider-account consistency checks.
- Its proxy authenticates before body access, strips credentials/hop headers, injects the selected
  account, streams without parsing, renews at 40 seconds, and lets the real response win over
  bookkeeping failure.
- It classifies 401 as reauthentication, 429 as quota cooldown, 403 as policy/workspace/origin
  evidence, 404 as model/account availability, and 5xx as transient.
- Its Pi remote-compaction extension uses a 120-second default and 600-second maximum timeout, 16
  MiB maximum response, terminal completion events, exactly one canonical compaction artifact,
  explicit session/prompt-cache identifiers, opaque response-item preservation, and a local summary
  fallback.

When porting the missing live quota and refresh implementation, preserve those checks. Do not copy
runtime-specific file or Kubernetes concerns into portable packages.

## Known platform and protocol hazards

- Local Wrangler/Miniflare has documented compressed-response buffering differences from deployed
  Workers. Unit tests and `wrangler dev` do not replace a deployed SSE canary.
- Cloudflare’s `TransformStream` implementation has compatibility notes. Prefer the smallest Web
  Streams surface and byte-identity tests.
- Node compatibility includes partial implementations and import-only stubs. Do not enable
  `nodejs_compat` unless a verified dependency requires it.
- AI Gateway retry, cache, payload logging, DLP, or Dynamic Routing settings can silently violate
  the transparent single-send contract. Override them per request and verify the dashboard.
- A 401 may invalidate only one credential generation. The future refresh port must not mark a newly
  rotated token bad because an older in-flight token was rejected.
- `Retry-After` may be seconds or an HTTP date. It is not the same as provider quota-reset data.
- Never retry after response bytes begin. Model work and tool side effects may already exist.
- A client that abandons a body without cancelling it can leave a lease until TTL cleanup.
- Bootstrap quota snapshots become stale. Until the live quota cache lands, operators must refresh
  snapshots and restart before 24 hours; this is not production-safe automation.
- Bootstrap access tokens expire. Until OAuth refresh lands, reauthentication is manual.

## Development workflow

Use test-driven development for every behavior change:

1. Add a focused failing test.
2. Run it and confirm the expected failure.
3. Implement the smallest coherent behavior.
4. Run the focused suite.
5. Run the full gates.

Required gates:

```bash
bun run format:check
bun run lint
bun run typecheck
bun test
bun run build:worker
```

`bun run check` runs the complete sequence. Also run `git diff --check` and scan changed code for
unchecked casts, `any`, non-null assertions, secrets, placeholders, and model-body reads.

Tests must cover:

- selection health, blocks, freshness, headroom, urgency, hysteresis, reservations, and stable ties;
- concurrent atomic acquisition, assignment/lease expiry, renew/release, and sanitized summaries;
- 401/429/403/404/5xx classification;
- both observed Codex usage shapes and duration/reset normalization;
- auth-before-body-access, every path, header stripping, opaque bytes, empty streams, cancellation,
  transport failure, bookkeeping failure, and compaction payloads;
- SQLite visibility across two instances;
- AES-GCM nonce/key/AAD failures;
- AI Gateway privacy/retry/cache headers;
- Worker RPC payload separation and Wrangler dry-run.

## Delivery and documentation

The owner has authorized direct, verified pushes to `main` for this repository. That authorization
does not waive tests, review of the diff, or remote verification.

Keep these documents synchronized with behavior:

- `README.md`: user-facing scope, status, setup, and entry points.
- `docs/architecture.md`: ports, data flow, policy, and runtime boundaries.
- `docs/operations.md`: secrets, deployment, canary, capacity, backup, and rollback.
- `docs/research.md`: evidence, request audit, alternatives, and dated external limits.
- `docs/security.md`: threat model, controls, gaps, rotation, and incident response.

Do not leave `TODO`, `FIXME`, fake secrets, placeholder account IDs, unverified performance claims,
or unsupported-product claims in committed docs. If a capability is incomplete, name it plainly as a
limitation and list the release gate.
