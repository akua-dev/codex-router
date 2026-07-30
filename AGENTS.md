# codex-router agent instructions

This is the authoritative project vision and engineering contract. Read it before changing code,
configuration, tests, deployment, or documentation.

There must be no singular `AGENT.md`; this `AGENTS.md` is the only repository agent brief.

## Mission

Build a small, auditable load balancer for Codex traffic backed by ChatGPT subscriptions.

The router must:

- maintain real short and weekly quota state;
- refresh OAuth credentials without generation races;
- keep sessions sticky while an account remains safe;
- reserve concurrent streams atomically;
- forward one opaque Responses request exactly once;
- preserve incremental response bytes;
- use Cloudflare AI Gateway for metadata-only observability;
- run the same Effect domain on Cloudflare Workers and Bun/AgentOS.

This is the “codex-lb problem” optimized for Cloudflare Workers and portable Effect services, not a
port of codex-lb’s Python/UI architecture.

## Product boundary and honesty

This project is subscription-only:

- Do not add OpenAI API-key accounts, API billing, `/v1` API upstreams, or provider-key fallback.
- Never invent a “Codex subscription API key.” ChatGPT OAuth access and refresh tokens are the
  credential model.
- The relay’s `x-api-key` is only an internal gateway-to-relay transport token. Strip it before
  `chatgpt.com` and never describe it as a model credential.
- Cloudflare AI Gateway cannot select accounts by ChatGPT quota and does not directly consume a
  ChatGPT plan.
- Dynamic Routing, `/compat`, semantic routing, and gateway spend limits do not replace this
  project’s quota/credential state.
- Never claim that technical controls make multi-account ChatGPT OAuth pooling an OpenAI-supported
  public API. Terms, privacy, ownership, and organization-policy review remain required.
- Do not describe Free-tier fit from request counts alone. Current deployed CPU evidence does not
  establish the 10 ms Free limit.
- HTTP/SSE is supported. Do not advertise WebSocket support without a native deployed protocol
  canary.

The deployed subscription path has passed exact-byte synthetic SSE, live usage, and minimal real
Codex CLI canaries. Keep [docs/canary.md](docs/canary.md) synchronized with later evidence.

## Repository and dependency direction

```text
packages/core
  schemas, selection, routing state models and classifications

packages/codex
  OAuth, usage decoding, generation-safe subscription router,
  account admin, protocol mapping, transparent handler

packages/bun
  native SQLite account/routing store, Effect maintenance schedule,
  Bun server and remote admin client

packages/cloudflare
  SQLite Durable Object, encrypted vault/keyring, Worker entrypoint,
  AI Gateway/control transports, cron integration

packages/relay
  authenticated fixed-route Bun egress relay

apps/server | apps/worker | apps/relay
  composition roots
```

Dependency flow:

```text
core <- codex <- bun app
              <- cloudflare app

codex <- relay <- relay app
```

`packages/core` and `packages/codex` must not import Bun, Node, Cloudflare, Wrangler, filesystem,
Kubernetes, or relay code. Runtime specifics stay behind ports. AgentOS must import portable
packages instead of copying policy.

The public external dependency is the repository root package, installed from Git at a full commit
SHA. Its supported entry points are `@akua-dev/codex-router/core`, `/codex`, `/bun`, `/cloudflare`,
and `/relay`. Bun does not create independently resolvable child workspaces when it installs a Git
repository, so production source crossing an internal package boundary must import the dependency
package's public source index by relative path. Do not reach into implementation files. Keep the
child workspace manifests private for local development and never add a divergent consumer snapshot,
GitHub subdirectory proxy, or registry proxy.

The root manifest owns the aligned runtime Effect dependency union needed by every exported entry
point. Keep `private: true` to prevent accidental npm publication; it does not make the public
GitHub repository private.

## Effect engineering contract

Use the vendored official Effect agent skill at `.agents/skills/effect-ts/SKILL.md` for every Effect
change. It comes from `Effect-TS/skills` source commit `a8b6bb40d1d4d550b49c0ff7a624b5e6da500a24`.
The matching Effect source checkout is pinned at `.repos/effect` commit
`acee26944bc89ee554d7b9fadab7443f9edc28a9`.

The repository currently pins `effect`, `@effect/vitest`, `@effect/platform-bun`,
`@effect/platform-browser`, `@effect/sql-sqlite-bun`, and `@effect/sql-sqlite-do` to exactly
`4.0.0-beta.102`. Before dependency changes, verify the latest mutually aligned official versions
and update every Effect package together.

Use Effect throughout application behavior:

- model operations as `Effect<A, E, R>`;
- use stable `Effect.fn("Name")` functions;
- use `Context.Service` ports and named Layers;
- use `ManagedRuntime` only at composition/runtime boundaries;
- build portable ingress with `HttpRouter`, `HttpEffect.toWebHandler`, and `HttpServerResponse.raw`
  for exact Web response preservation;
- host Bun processes with `BunHttpServer.layer`, `HttpRouter.serve`, `Layer.launch`, and
  `BunRuntime.runMain`;
- use `BunServices` for filesystem/path/process capabilities, `BunHttpClient` for decoded control
  traffic, `BunCrypto` in Bun, and `BrowserCrypto` in Workers;
- use `@effect/sql-sqlite-bun` for Bun SQLite and `@effect/sql-sqlite-do` plus its official migrator
  for Durable Object SQLite;
- use `Encoding`, `Crypto`, `Clock`, `Stream`, and `Schedule` instead of local helpers wherever
  their semantics apply;
- use scoped fibers and Effect `Schedule` for Bun background maintenance;
- decode every external value with `Schema`, including env, JSON, SQL, JWT claims, OAuth responses,
  usage responses, Durable Object RPC, and encrypted envelopes;
- use `Schema.Class` for persisted/transmitted models;
- use `Schema.TaggedErrorClass` for expected failures;
- use `Redacted` for every secret value;
- use `Effect.result`, typed recovery, interruption, and scoped cleanup instead of ad hoc promise
  catch trees;
- test Effects with `@effect/vitest` and dependency Layers.

Do not use `any`, unchecked double casts, non-null assertions, namespaces, thrown strings, raw
probing of `unknown`, scattered `Effect.provide`, or one-off global mutable service containers.

The Worker environment and Durable Object stub are request-scoped. Never retain a request’s bindings
in a global ManagedRuntime. Keep the runtime alive through the response stream and dispose it once
the body ends, errors, or is cancelled.

## Protocol and streaming contract

Accepted model `POST` paths:

- `/responses`
- `/v1/responses`
- `/codex/responses`
- `/responses/compact`
- `/v1/responses/compact`

They all map to `https://chatgpt.com/backend-api/codex/responses`.

Native Codex compaction fields are opaque. Do not parse or persist prompts, input items, tool calls,
encrypted reasoning, summaries, compaction artifacts, or model output.

Invariants:

1. Authenticate before body access.
2. Validate method/path before account acquisition.
3. Accept only explicit, non-empty session identifiers up to 256 characters.
4. Acquire one account, lease, and current credential generation.
5. Strip caller provider credentials and hop-by-hop headers.
6. Inject only the selected subscription credential.
7. Transmit once; never replay after the transport call.
8. Never call `text()`, `json()`, `arrayBuffer()`, `clone()`, or `tee()` on a model request or
   response.
9. Preserve upstream status, status text, safe headers, ordering, chunks, and bytes.
10. Release on empty body, end, cancellation, read error, or pre-response transport failure.
11. Renew a long stream no more often than once per elapsed 40 seconds.
12. Bookkeeping failure must never replace a real upstream response.

Remove response headers invalidated by runtime decoding/reframing: `connection`, `content-encoding`,
`content-length`, `proxy-authenticate`, `te`, `trailer`, `transfer-encoding`, and `upgrade`.

## AI Gateway SSE encapsulation

The deployed custom-provider path inserted random `nonce` properties into JSON SSE events even with
payload logging disabled.

To preserve bytes:

- the relay carries upstream SSE through AI Gateway as `application/octet-stream`;
- it adds only `x-codex-upstream-content-type: text/event-stream`;
- the Worker removes the marker and restores `text/event-stream`;
- neither side reads or reserializes the body.

Do not “simplify” this away without repeating the deployed exact-byte fixture and confirming that AI
Gateway no longer mutates the stream.

## Selection policy

Carry forward the tested AgentOS policy:

1. Reject disabled or reauthentication-required accounts.
2. Reject active quota or transient blocks.
3. Reject unknown usage.
4. Reject usage older than 24 hours.
5. Reject missing or elapsed weekly resets.
6. Treat usage older than 60 seconds as stale fallback.
7. Penalize stale weekly headroom by five percentage points.
8. Require 10% short-window and 3% weekly remaining.
9. Score quota-expiry urgency as:

   ```text
   weekly remaining percent / max(0.25, hours until weekly reset)
   ```

10. Prefer quota most at risk of expiring unused.
11. Keep a session’s current eligible account when within 10% of the best score.
12. Break ties by weekly remaining, short remaining, active reservations, then opaque account ID.

A known weekly-only provider response is valid. Model the absent short window as unused with no
reset. Continue to reject short-only, malformed, negative, non-finite, or unknown-duration windows.

Never round-robin individual requests. Never derive stickiness from IP, user agent, prompt, token,
credential, or human identity.

## State and lifecycle

- Assignment TTL: seven days.
- Lease TTL: 120 seconds.
- Stream renewal interval: 40 seconds.
- Usage freshness: 60 seconds.
- Maximum usage age: 24 hours.
- Refresh claim TTL: 30 seconds.
- Credential refresh lead: five minutes.
- Maintenance cadence: one minute.

Atomic acquisition cleans expired state, overlays response health, selects with reservation counts,
creates a lease, and optionally upserts the assignment.

Every credential has a monotonically increasing router generation:

- refresh and usage claims carry the expected generation;
- refresh commits advance by exactly one;
- provider identity must remain equal;
- usage commits apply only to their producing generation;
- 401/health evidence applies only if its generation remains current;
- late work from generation N must never invalidate N+1.

On invalid grant or provider-identity change, mark only the matching current generation as requiring
reauthentication. On transient refresh/usage failures, retain valid stale usage within the 24-hour
limit.

Cloudflare uses one SQLite Durable Object named `global`. It owns account/routing state and
encrypted credentials through the official Effect Durable Object SQLite client, repository, and
ordered `effect_sql_migrations`, but never receives model bodies or holds model streams.

Bun uses native SQLite and `BEGIN IMMEDIATE`. One normal SQLite PVC means one writer replica.
Multi-replica Bun requires a different state adapter with equivalent atomicity.

Workers KV is forbidden for credentials, claims, leases, assignments, blocks, and quota because it
lacks the required atomic consistency.

## Credential and privacy contract

- Credential bundles never appear in candidates, decisions, summaries, errors, URLs, response
  headers, telemetry, or logs.
- Cloudflare persists bundles only as AES-256-GCM ciphertext.
- Use a random 96-bit nonce, explicit immutable key version, and opaque account ID as AAD.
- Keep all key versions that still have ciphertext; never reuse a version with different bytes.
- Old-version decryption may migrate the record with a fresh nonce under the current key.
- Disabled accounts must be explicitly exercised before old-key retirement.
- Bun SQLite credential rows require encrypted storage/backups and strict filesystem access.
- AI Gateway Run token is added only as `cf-aig-authorization`.
- Always set `cf-aig-skip-cache: true`, `cf-aig-collect-log-payload: false`, and
  `cf-aig-max-attempts: 1`.
- AI Gateway metadata is bounded to five small non-sensitive entries.
- DLP is off because request inspection and response buffering violate the proxy boundary.
- Never log full headers. Authorization, API-key variants, router/admin/relay tokens,
  `chatgpt-account-id`, cookies, refresh material, and forwarded identity are sensitive.
- Status/admin surfaces expose opaque IDs and sanitized state only.

## Egress relay contract

Cloudflare AI Gateway’s direct custom-provider egress to `chatgpt.com` was rejected during deployed
testing. The custom provider targets a dedicated Cloudflare Tunnel to the Bun relay.

The relay:

- accepts unauthenticated `GET /healthz` only;
- authenticates all other requests with the distinct relay transport token;
- accepts only tested usage, Responses, and synthetic-canary routes, including AI Gateway’s `/v1`
  prefix;
- uses fixed upstream URLs;
- requires the selected subscription authorization and provider-account identity;
- strips relay, Cloudflare, forwarded, cookie, compression, origin, and hop headers;
- never selects accounts, refreshes OAuth, or parses payloads;
- runs non-root with a read-only filesystem, no service-account token/capabilities, resource limits,
  pinned images, no ingress, and DNS/443/7844-only egress.

Do not turn it into a general open proxy.

## Request-volume and capacity baseline

Audit date: 2026-07-30.

- Local Codex: 8,028 rollout files.
- Raw local terminal records: 1,993,486.
- Inferred distinct local completed calls after resume/fork deduplication: 570,364.
- Remote live AgentOS calls, July 21–30: ~15,219.
- Local OrbStack AgentOS: 1,349.
- Known combined lower bound: ~586,932.
- Twenty scaled-to-zero AgentOS StatefulSets had unmounted 20 GiB PVCs and remain uncounted.
- No matching rollout filenames were found between audited local and remote sets.
- Last nine complete UTC days: 105,034.
- Recent average: 11,670/day.
- Observed peak: 24,657/day, 117/minute, 9/second.
- Remote-cluster peak: ~3,249/day.
- Inspected AgentOS gateway: two accounts and 69 sticky assignments.

At peak plus minute maintenance:

- Worker requests: 26,097/day, 26.097% of 100,000/day.
- Baseline DO requests: 75,411/day, 75.411% before long-stream renewals/admin traffic.
- AI Gateway peak ingress: 1.8% of 500 logs/second.
- AI Gateway 100,000-log history lasts about 7.6 days with one enabled account or 6.9 days with two
  at the recent model average.

The current Effect-platform release smoke recorded eight successful Worker invocations with 217.134
ms aggregate CPU (27.142 ms average) and a 39.389 ms minute p99. The earlier fuller real-canary
window recorded nine with 187.188 ms (20.80 ms average) and a 46.481 ms minute p99. Request counts
fit Free; CPU does not justify a Free-tier guarantee. Prefer Workers Paid unless newer
representative telemetry proves otherwise.

## AgentOS and Pi evidence

The design was derived from `/Users/robin/Developer/cnap-tech/agentos`:

- quota freshness/age, selection thresholds, expiry urgency, stale penalty, affinity, leases, and
  renewal intervals;
- private vault files, atomic replacement, refresh claims, rejected-token generation checks, and
  provider-identity verification;
- auth-before-body, header stripping, selected credential injection, one-send streaming, and
  response-first bookkeeping;
- response classification for 401/429/403/404/5xx.

The Pi remote-compaction extension contributed the client-side expectations for 120/600-second
timeouts, a 16 MiB response bound, terminal completion, exactly one canonical artifact, explicit
session/cache identifiers, opaque item preservation, and local fallback.

Keep those compaction response-size/artifact checks in the client/extension. The proxy must remain
opaque.

## Issues not to introduce

- No API-key or provider-budget mode.
- No prompt classification or semantic model choice.
- No body logging, DLP, caching, replay, fallback transmission, JSON/SSE parsing, hashing, cloning,
  teeing, or buffering.
- No global Worker runtime holding request-bound bindings.
- No model stream through the Durable Object.
- No KV coordination.
- No session inference from personal/network data.
- No static relay header in AI Gateway in place of per-request secret injection.
- No direct `chatgpt.com` AI Gateway provider until a deployed canary proves it works.
- No removal of SSE encapsulation based only on local tests.
- No broad relay route, redirects, cluster ingress, service-account token, floating image tag, or
  unrestricted egress.
- No secret in a command argument, ConfigMap, Git diff, log, status, test snapshot, or ticket.
- No old AES key retirement while ciphertext count is nonzero.
- No claim that bundle size proves CPU fit.
- No use of local Miniflare success as deployed stream evidence.
- No TODO/FIXME, fake secret, placeholder identity, or unsupported-product claim in committed docs.

## Development workflow

Use test-driven development for every behavior change:

1. write a focused failing test;
2. run it and confirm the expected failure;
3. implement the smallest coherent behavior;
4. run the focused suite;
5. run the full gate.

Required gate:

```bash
bun run check
git diff --check
```

Also scan changed code for:

- `any`, double casts, non-null assertions, namespaces, secret-like literals;
- model-body reads/clones/tees;
- caller credentials escaping sanitation;
- API-key/upstream regressions;
- placeholders and stale documentation.

Tests must cover selection, freshness, weekly-only usage, generation races, concurrent acquisition,
claim expiry, OAuth refresh/identity checks, response classification, auth-before-body, all paths,
header stripping, exact bytes, empty/cancelled/error streams, bounded renewal, bookkeeping failure,
SQLite visibility, AES key/AAD/nonce/version failures, key migration, admin auth/lifecycle, AI
Gateway privacy/encapsulation, Worker request lifetime, scheduled maintenance, relay fixed routes,
Kubernetes hardening, and Wrangler dry run.

## Delivery

Direct verified pushes to `main` are authorized. That does not waive:

- full local gate;
- diff/security review;
- immutable relay image rebuild and Kubernetes rollout when relay sources change;
- Worker deploy when Worker sources/config change;
- deployed health/status/synthetic/privacy verification;
- remote commit synchronization.

Keep these synchronized:

- `README.md`
- `docs/architecture.md`
- `docs/operations.md`
- `docs/canary.md`
- `docs/research.md`
- `docs/security.md`

Use Cloudflare MCP/API or Wrangler for Cloudflare operations. Do not use browser automation for
Cloudflare control-plane changes.
