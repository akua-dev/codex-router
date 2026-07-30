# Effect Platform Migration Design

**Date:** 2026-07-30

**Status:** Approved for implementation

## Outcome

`codex-router` will use every official Effect capability that directly replaces a handwritten
runtime, infrastructure, or application abstraction in the current system. The migration covers
Cloudflare Durable Object SQLite, Bun process and HTTP hosting, portable HTTP routing, non-opaque
HTTP clients, cryptographic digests and identifiers, Base64URL encoding, clocks, schedules, resource
lifetimes, typed errors, layers, and Effect-aware tests.

The migration must preserve the existing product and protocol boundaries:

- ChatGPT/Codex subscription OAuth remains the only model credential.
- The router remains a quota-aware account load balancer, not a semantic or model router.
- Model request and response bodies remain opaque.
- Each model request is transmitted exactly once.
- Native request and response streams retain their byte order, chunk boundaries, status, and safe
  headers.
- Cloudflare AI Gateway remains metadata-only and must not cache, retry, inspect, or mutate model
  payloads.
- The portable domain continues to run on Cloudflare Workers and Bun/AgentOS.

All Effect packages remain pinned to the mutually aligned current beta, `4.0.0-beta.102`, verified
from the package registry on 2026-07-30.

## Applicability Rule

“Use all Effect support” means using an official Effect abstraction when it replaces a capability
the project actually needs. It does not mean adding unrelated Effect modules or changing the
product.

| Capability                               | Decision                        | Reason                                                                                                                           |
| ---------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `@effect/sql-sqlite-do`                  | Use                             | It is the official adapter for SQLite Durable Objects and replaces raw `storage.sql`.                                            |
| `@effect/sql-sqlite-bun`                 | Keep and complete               | It is already used for Bun persistence.                                                                                          |
| `@effect/platform-bun`                   | Use throughout Bun entrypoints  | It replaces manual `Bun.serve`, signal handling, filesystem, crypto, and runtime startup.                                        |
| `@effect/platform-browser/BrowserCrypto` | Use in Workers                  | Workers expose Web Crypto and the official adapter supplies `Crypto.Crypto`.                                                     |
| Effect HTTP router/Web bridge            | Use                             | It supplies one portable HTTP application model for Bun and Workers.                                                             |
| Effect `HttpClient`                      | Use for decoded control traffic | OAuth, quota, and admin responses are intentionally decoded and benefit from typed HTTP errors.                                  |
| Effect `Crypto` and `Encoding`           | Use                             | They replace handwritten SHA digests, UUID generation, and Base64URL codecs.                                                     |
| Effect `Clock` and `Schedule`            | Use                             | They replace application-level wall-clock reads, polling, delays, and recurring Bun work.                                        |
| Effect `Stream`                          | Use for owned/generated streams | It fits the synthetic canary and ordinary application streams.                                                                   |
| Native Web streams                       | Retain for opaque model traffic | Re-encoding an upstream model stream risks chunk changes and unnecessary Worker CPU.                                             |
| Web Crypto AES-GCM                       | Retain behind an Effect service | Effect `Crypto` has digest/random support but no AES-GCM API.                                                                    |
| D1                                       | Do not add                      | The design requires one strongly consistent SQLite Durable Object, not a separate D1 database.                                   |
| Effect AI modules                        | Do not add                      | The router must not parse prompts, invoke semantic models, or interpret model responses.                                         |
| Effect Workflows/Cluster                 | Do not add                      | Refresh work is short and generation-safe in SQLite; Cloudflare cron and Effect schedules suffice.                               |
| OTLP exporter                            | Do not add by default           | AI Gateway and Cloudflare invocation telemetry are the required sinks; a new exporter is not a replacement for current behavior. |
| `HttpApi`                                | Do not require                  | `HttpRouter` handles raw proxy routes without forcing body decoding; admin schemas remain explicit.                              |

## Architecture

### Portable domain

`packages/core` and `packages/codex` remain runtime-neutral. Their public operations return
`Effect<A, E, R>`, require services through `Context.Service`, decode external values through
`Schema`, and expose named layers.

The portable HTTP application will use Effect’s HTTP request service and router while extracting the
underlying Web `Request` only at the transparent proxy boundary. It will return an Effect HTTP
response that carries the original Web `Response` as a raw runtime value for model traffic. This
keeps the HTTP routing and error lifecycle in Effect without reading or re-chunking the model body.

Model-path code may retain native Web `ReadableStream` callbacks for lease renewal and release.
Those callbacks are runtime boundaries: they may run already-constructed Effects, but they must not
decode, clone, tee, hash, or buffer the body.

### Runtime adapters

Runtime packages provide only concrete infrastructure:

- `packages/bun`: Bun SQL, Bun platform services, server composition, and remote administration.
- `packages/cloudflare`: Durable Object SQL, Web Crypto, Worker bindings, AI Gateway transport, cron
  integration, and request-scoped runtime composition.
- `packages/relay`: the fixed-route relay HTTP application; the Bun app provides its runtime.

No Cloudflare, Bun, filesystem, Kubernetes, or relay type may move into the portable packages.

## Cloudflare Durable Object

### SQL client and migrations

`RouterStateObject` will use:

- `@effect/sql-sqlite-do/SqliteClient`
- `@effect/sql-sqlite-do/SqliteMigrator`
- `effect/unstable/sql/SqlClient`
- schema-decoded query results

The Durable Object storage handle is supplied to `SqliteClient.layer({ storage })`. The official
client provides typed SQL errors, spans, serialized connection access, and Cloudflare-managed
transactions.

The current multi-statement schema string and `schema_migrations` table are replaced by an ordered
Effect migration record. The official `effect_sql_migrations` table records applied migrations.
Request handling waits for migration completion through `blockConcurrencyWhile`.

The logical tables, indexes, constraints, and existing data remain compatible. Migration must not
drop, rename, rewrite, or expose credential rows. Existing deployed objects must start against their
current schema without data loss.

### Transactional routing

Route acquisition, assignment updates, reservation creation, response-health updates, refresh
claims, generation checks, and administrative mutations use `SqlClient.withTransaction`.

The route-acquire transaction still performs, atomically:

1. cleanup of expired leases, assignments, claims, and blocks;
2. candidate, usage, health, assignment, and reservation-count reads;
3. deterministic portable selection;
4. lease insertion;
5. optional sticky-assignment upsert;
6. encrypted credential-envelope return.

No provider network call occurs inside a SQL transaction.

### Durable Object runtime boundary

The Durable Object owns one `ManagedRuntime` constructed from the SQLite, Web Crypto, configuration,
and service layers. Public Durable Object methods are native Cloudflare callbacks, so `fetch()` is
the single Promise boundary for request work.

Internal operations become named `Effect.fn` workflows. They do not call `Effect.runPromise` or
`Effect.runSync` individually. Initialization, migrations, and configured-account seeding run
through the same runtime.

The runtime belongs to the Durable Object instance, not a global Worker variable. It never contains
an incoming model body or a per-request Durable Object stub.

## Bun Runtime

### Server and relay hosting

The server and relay apps use:

- `BunRuntime.runMain`
- `BunHttpServer.layer`
- `HttpRouter.serve`
- `Layer.launch`

This replaces direct `Bun.serve`, handwritten signal handlers, and manual shutdown promises.
`BunHttpServer` owns listener acquisition, graceful shutdown, request interruption, and streamed
response scope.

The server and relay continue to bind only their configured hostname and port. The relay retains its
fixed allowlist, authentication, header sanitation, and no-redirect behavior.

### Bun services

`BunServices` supplies filesystem, path, crypto, and other platform services. Database-directory
creation becomes an Effect filesystem operation. Lease and claim identifiers use `Crypto.Crypto`
instead of `crypto.randomUUID()`.

The Bun runtime layer is constructed once at the composition root and reused. Layer-producing
functions are called once per configured application; the resulting named layer values are reused to
preserve Effect layer memoization.

## HTTP

### Inbound routing

Effect `HttpRouter` owns health, status, administration, canary, key-version, and proxy route
dispatch. Runtime-specific routes are composed as layers around the shared router.

Authentication remains before body access. Model paths continue to pass the original Web `Request`
to the transparent handler. Invalid method, path, or session identifiers are rejected without
touching the body.

The Worker uses Effect’s Web-handler bridge at its Cloudflare callback boundary. The Worker
environment is decoded per invocation and no global `ManagedRuntime` retains request-scoped
bindings. Runtime disposal remains tied to response completion or cancellation.

### Outbound control traffic

OAuth device authorization, OAuth refresh, live quota probes, and remote account administration use
Effect `HttpClient`. Runtime adapters provide the actual client:

- Bun uses the official Bun HTTP client.
- Workers use the Fetch-based Effect HTTP client, optionally decorated by the Cloudflare control
  transport needed for AI Gateway and relay routing.
- Tests provide Effect client layers.

Control responses use status/header accessors and schema JSON decoders. Expected transport,
authentication, throttling, payload, and identity failures remain tagged domain errors.

### Opaque model traffic

The model transport, AI Gateway transport, and relay upstream hop retain Web `Request`, Web
`Response`, and native Web bodies. Native fetch is justified here because Effect `HttpClient` does
not expose the original Web `Response`, and rebuilding it would weaken the exact stream contract.

Every native fetch call remains wrapped in a named Effect operation with a typed transport error and
request-signal propagation. There is no retry after transmission.

## Crypto and Encoding

Effect `Encoding.encodeBase64Url` and `Encoding.decodeBase64Url` replace local codecs in credential
parsing, Worker keyring validation, encrypted envelopes, and tests.

Effect `Crypto.Crypto` supplies:

- SHA-256 digests used for constant-time token comparison;
- lease identifiers;
- refresh-claim identifiers;
- AES-GCM nonce bytes.

Bun provides `BunCrypto.layer`; Workers provide the official Web Crypto-backed layer. Tests provide
deterministic crypto layers only when determinism is required.

AES-256-GCM import, encryption, and decryption remain Web Crypto operations wrapped by typed Effects
because Effect does not expose symmetric AES operations. Keys remain non-extractable. AAD remains
the immutable opaque account ID and credential generation. Nonces remain random 96-bit values.

Constant-time comparisons remain length-independent at the secret-value level by comparing
fixed-length SHA-256 digests.

## Time, Scheduling, and Concurrency

Runtime wall-clock reads use Effect `Clock`; domain operations continue to accept explicit `now`
values where deterministic decisions or atomic SQL statements require them.

Bun maintenance uses the existing one-minute Effect `Schedule`, scoped fibers, and interruption-safe
cleanup. Device authorization polling and retryable control calls use bounded Effect schedules. The
synthetic canary uses an owned Effect stream with scheduled chunk delays.

Cloudflare continues to use its native minute Cron Trigger. The callback runs the same Effect
maintenance workflow and passes its Promise to `waitUntil`. Cloudflare Workflows are unnecessary
because claims and generations already make work bounded, idempotent, and recoverable.

## Error and Resource Handling

Expected failures remain `Schema.TaggedErrorClass` values. Foreign SQL, HTTP, Web Crypto, and
platform failures are translated once at adapter boundaries without including secrets.

Defects and interrupts are handled only at application boundaries:

- HTTP boundaries return existing sanitized error responses;
- Bun runtime reports startup defects and sets the process exit status;
- Worker and Durable Object boundaries never serialize causes, headers, tokens, ciphertext, or
  provider identity.

Managed resources use scopes and layers. There are no ad hoc promise catch trees for application
behavior. A native model response remains the one special lifetime: its wrapper releases and renews
the lease and disposes the request-scoped Worker runtime when the body ends, errors, or is
cancelled.

## Testing Strategy

Implementation follows red-green-refactor. Each migration slice begins with a focused failing test.

Required focused evidence includes:

- Durable Object initialization creates and records official Effect migrations.
- Existing schema/data remain readable after the migrator is introduced.
- `SqlClient.withTransaction` commits successful acquisitions and rolls back failed multi-statement
  changes.
- Concurrent acquisition preserves reservation counts and atomic selection.
- Generation-safe credential, usage, and response commits retain their current race behavior.
- Bun server and relay run through Effect HTTP layers and stop through scoped finalization.
- Worker bindings remain request-scoped and runtime disposal follows empty, completed, cancelled,
  and errored responses.
- Control-plane HTTP clients decode schemas and classify transport/status failures.
- Effect Crypto and Encoding preserve JWT, keyring, envelope, AAD, nonce, and key-rotation behavior.
- The synthetic stream keeps its intentional multibyte split.
- Model request bodies are never read before authentication or during forwarding.
- Exact upstream status, safe headers, chunk sequence, and bytes survive the Bun, Worker, AI
  Gateway, and relay paths.
- No model request is retried or transmitted twice.

Tests use `@effect/vitest`, `it.effect`, test layers, and `TestClock` where time advances are part
of the behavior. Native Web-stream boundary tests may remain async Vitest tests when the assertion
is about host stream semantics rather than an Effect workflow.

## Documentation and Operations

The implementation updates:

- `AGENTS.md`
- `README.md`
- `docs/architecture.md`
- `docs/operations.md`
- `docs/canary.md`
- `docs/research.md`
- `docs/security.md`

Documentation names the Effect capabilities actually used and the native streaming/AES exceptions.
It must not claim D1, Workflows, semantic routing, OpenAI API-key support, or automatic Free-tier
fitness.

## Delivery

The completed migration must pass:

```bash
bun run check
git diff --check
```

The changed tree is also scanned for unsafe casts, `any`, non-null assertions, body reads,
clones/tees, secret-like literals, stale API-key claims, unfinished markers, and unmanaged runtime
calls.

Because both Worker and relay hosting change, delivery includes:

1. immutable relay image build and push;
2. AgentOS Kubernetes rollout and health verification;
3. Cloudflare Worker deployment with Wrangler or the Cloudflare control-plane tools;
4. synthetic exact-byte canary;
5. minimal real Codex subscription canary;
6. AI Gateway privacy/logging inspection;
7. remote commit synchronization;
8. a fully verified direct push to `main`.
