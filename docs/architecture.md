# Architecture

## Product boundary

`codex-router` balances Codex Responses traffic across ChatGPT subscription accounts. It is a quota
and account-health router, not a semantic model router, general OpenAI API proxy, or telemetry
collector.

Its hot-path responsibilities are deliberately narrow:

1. authenticate before body access;
2. acquire one eligible subscription account;
3. retrieve only that account’s current credential generation;
4. transmit the request once;
5. preserve the opaque response stream;
6. record health and release the lease.

Cloudflare AI Gateway is an observability hop. It does not select accounts or know ChatGPT
subscription quota.

## Portable dependency boundary

```text
@akua-dev/codex-router-core
              ^
              |
@akua-dev/codex-router-codex
              ^
              |
       +------+-----------------+
       |                        |
@akua-dev/codex-router-bun   @akua-dev/codex-router-cloudflare
       |                        |
 apps/server                apps/worker

@akua-dev/codex-router-relay -> apps/relay
```

`core` and `codex` contain no Cloudflare, Wrangler, Bun, Node, filesystem, or Kubernetes imports.
They model behavior as Effect services. Runtime packages implement the ports and own persistence,
scheduling, crypto, and process/runtime boundaries.

The relay is separate because it is only a fixed-route transport bridge. It never owns selection,
usage, refresh, leases, or assignments.

## Effect service graph

| Service                    | Responsibility                                                          |
| -------------------------- | ----------------------------------------------------------------------- |
| `ClientAuthenticator`      | Authenticate model callers before body access                           |
| `AdminAuthenticator`       | Authenticate the separate account-administration surface                |
| `SubscriptionAccountStore` | Atomic account, credential, usage, claim, lease, assignment persistence |
| `SubscriptionRouter`       | Refresh, select, acquire, renew, record, release, maintain              |
| `OAuthClient`              | Device authorization and refresh-token exchange                         |
| `UsageProbe`               | Fetch and decode live Codex quota windows                               |
| `AccountAdmin`             | Sanitized list/import/enable/disable/remove lifecycle                   |
| `UpstreamTransport`        | Perform the one allowed model transmission                              |
| `GatewayTelemetry`         | Emit bounded payload-free decision/bookkeeping events                   |

External inputs are Schema-decoded. Expected failures are typed. Portable ingress is registered with
`HttpRouter`; the Web bridge returns `HttpServerResponse.raw` for the opaque response rather than
converting its body into an Effect stream. Composition roots build named Layers and ManagedRuntimes
only at runtime boundaries.

Decoded OAuth, usage, and administration traffic uses Effect `HttpClient`. The model hop remains
native Web `fetch` by design because its original `Request`, `Response`, and `ReadableStream` are
the protocol-fidelity boundary.

## Cloudflare production path

```text
                         small internal RPC only
                     +-----------------------------+
                     |                             v
client -> Worker -> subscription router -> SQLite Durable Object
            |                                  |
            |                                  +-- routing/health/usage
            |                                  +-- refresh/usage claims
            |                                  +-- encrypted credentials
            |
            | one opaque body stream
            v
      AI Gateway custom provider
            |
            | Cloudflare Tunnel
            v
      Bun egress relay
            |
            v
        chatgpt.com
```

The Worker constructs a request-scoped ManagedRuntime. This is intentional: a Durable Object stub
comes from the current request environment and must not leak through a global runtime. The runtime
stays alive until a streamed response ends, errors, or is cancelled, then disposes exactly once.

The Worker uses the generic Effect Web/`HttpRouter` bridge plus `BrowserCrypto`; there is no
separate official Cloudflare runtime package in the pinned Effect source. Cloudflare-specific
support comes from Web-standard Effect modules and `@effect/sql-sqlite-do`.

The Durable Object is named `global`. It never receives model request or response bodies and never
holds an upstream stream open.

### Why the relay exists

Deployment testing found that direct Cloudflare AI Gateway custom-provider egress to `chatgpt.com`
was rejected by the upstream Cloudflare edge. The custom provider therefore points to a dedicated
Cloudflare Tunnel whose origin is a Bun relay in Kubernetes.

The relay:

- exposes only `GET /backend-api/wham/usage`, `POST /backend-api/codex/responses`, and the synthetic
  canary, with AI Gateway’s optional `/v1` prefix;
- requires a dedicated `x-api-key` transport token on every non-health request;
- requires subscription authorization and provider-account headers for real upstream requests;
- strips Cloudflare, forwarding, relay-auth, hop-by-hop, compression, cookie, and origin-server
  headers as appropriate;
- uses fixed upstream URLs and disables automatic redirect following;
- passes request and response bodies without reading them.

The `x-api-key` is only relay transport authentication. It is not an OpenAI API key and is never
sent to `chatgpt.com`.

### Exact-byte SSE across AI Gateway

The deployed synthetic fixture showed AI Gateway inserting random `nonce` properties into JSON SSE
events, even with payload storage disabled. That violates byte transparency.

The relay now changes only transport metadata:

1. upstream `text/event-stream` is carried through AI Gateway as `application/octet-stream`;
2. a controlled `x-codex-upstream-content-type: text/event-stream` marker is added;
3. the Worker removes the marker and restores `text/event-stream`;
4. neither component reads, parses, clones, tees, hashes, or reserializes the body.

The deployed canary proves the final 62 bytes are identical and arrive incrementally.

## Request lifecycle

```text
authenticate
  -> validate method/path/session
  -> maintain selected account enough for a usable credential + quota
  -> atomic acquire(account, lease, optional sticky assignment)
  -> fetch encrypted selected credential and decrypt in Worker
  -> strip caller/provider/hop headers
  -> one AI Gateway request
  -> record response classification for the same credential generation
  -> stream bytes to caller
  -> renew at most once per elapsed 40 seconds
  -> release on end, empty body, cancellation, read error, or transport failure
```

Bookkeeping failure never replaces a real upstream response.

The body contract forbids `text()`, `json()`, `arrayBuffer()`, `clone()`, and `tee()` on model
requests and responses. The synthetic test tools may consume the controlled fixture at the client
boundary; production forwarding may not.

## Quota and selection

A candidate is rejected when it is disabled, requires reauthentication, has an active quota or
transient block, lacks usage, has usage older than 24 hours, has no future weekly reset, or has less
than 10% short-window / 3% weekly headroom.

Usage older than 60 seconds is a penalized fallback until the 24-hour cutoff. A provider response
with only a known seven-day window is valid: its short window is modeled as unused with no reset,
while the weekly window remains authoritative.

Eligible accounts are ranked by quota-expiry urgency:

```text
weekly remaining percent / max(0.25, hours until weekly reset)
```

Quota most at risk of expiring unused is preferred. A seven-day sticky assignment remains when its
account is within 10% of the best score. Final ties use weekly headroom, short headroom, active
reservations, then opaque account ID.

Anonymous traffic is balanced but never assigned using inferred identity.

## Generation-safe credential lifecycle

Every subscription credential has a monotonically increasing router generation.

- Refresh and usage work uses per-account, per-operation claims with expiry.
- A refresh commit succeeds only if the claim, expected generation, and replacement generation all
  match.
- Provider identity extracted from the new access token must equal the stored identity.
- A usage result commits only for the generation that produced it.
- A 401 marks reauthentication only if that rejected generation is still current.
- A late rejection, quota response, or refresh result from generation N cannot invalidate generation
  N+1.

OAuth refresh starts five minutes before expiry. Invalid-grant or provider-identity mismatch marks
the matching generation for reauthentication. Transient control-plane failures retain usable stale
usage within the 24-hour bound.

Workers run maintenance every minute with a cron trigger. Bun runs the same portable
`SubscriptionRouter.maintain` operation using `Schedule.spaced("1 minute")`.

## State implementations

### Cloudflare

One SQLite Durable Object owns account state, encrypted credential records, usage snapshots, refresh
claims, routing health, leases, and sticky assignments. AES-256-GCM uses a random 96-bit nonce,
explicit key version, and opaque account ID as additional authenticated data.

The object owns one instance-scoped `ManagedRuntime`. `@effect/sql-sqlite-do` serializes access,
`SqliteMigrator` records the ordered non-destructive schema in `effect_sql_migrations`, repository
rows are Schema-decoded, and multi-statement state changes use Effect SQL transactions. Migration
and bootstrap seeding finish inside `blockConcurrencyWhile`.

Keyrings allow old and current key versions simultaneously. Online rotation rewrites and verifies
records before an old key is retired.

### Bun / AgentOS

`@effect/sql-sqlite-bun` uses native SQLite and `BEGIN IMMEDIATE` for the same atomic contracts.
Bootstrap accounts seed only missing records; routine lifecycle uses the admin API and persisted
database.

The Bun server and relay are scoped `BunHttpServer` layers served by `HttpRouter`. Composition uses
`Layer.launch` and `BunRuntime.runMain`, so signal interruption closes HTTP, SQLite, maintenance,
and other scoped resources. The relay generates only its controlled canary with Effect `Stream` and
`Clock`; real model bodies remain native Web streams.

One normal SQLite file means one Bun writer replica. Multi-replica AgentOS deployment requires a
different adapter with equivalent transaction semantics.

## Response classification

| Status    | Classification | Effect on matching credential generation               |
| --------- | -------------- | ------------------------------------------------------ |
| 2xx–3xx   | success        | clear transient evidence                               |
| 401       | reauth         | require reauthentication only if generation is current |
| 429       | quota          | temporary quota block; honor valid `Retry-After`       |
| 403       | forbidden      | policy/workspace/origin evidence                       |
| 404       | not found      | model/account availability evidence                    |
| other 4xx | client error   | do not punish the account as an upstream failure       |
| 5xx       | transient      | temporary block evidence                               |

`Retry-After` is cooldown evidence, not a replacement for live provider quota windows.

## Protocol mapping

All five incoming model paths map to `https://chatgpt.com/backend-api/codex/responses`:

- `/responses`
- `/v1/responses`
- `/codex/responses`
- `/responses/compact`
- `/v1/responses/compact`

Native compaction payloads are opaque. HTTP/SSE is supported; WebSocket behavior is not claimed.
