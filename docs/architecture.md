# Architecture

## Purpose

`codex-router` balances Codex Responses traffic across account quota pools. It is intentionally
narrow: select an eligible account, maintain safe session affinity, reserve capacity, forward one
opaque request, and preserve one opaque response stream.

It is not a prompt classifier, model-quality router, general OpenAI compatibility gateway, or
telemetry collector. Cloudflare AI Gateway is downstream observability; it does not own selection
policy or state.

## Dependency boundary

```text
@akua-dev/codex-router-core
              ^
              |
@akua-dev/codex-router-codex
              ^
              |
       +------+------+
       |             |
      Bun       Cloudflare
       |             |
 apps/server    apps/worker
```

`core` owns domain schemas and decisions. `codex` owns protocol-level services and the transparent
handler. The runtime packages implement those ports. Runtime-specific imports cannot move into the
portable packages.

## Effect service graph

The handler depends on five services:

| Service               | Responsibility                                                   |
| --------------------- | ---------------------------------------------------------------- |
| `ClientAuthenticator` | Compare the caller’s router token before body access             |
| `AccountDirectory`    | Supply candidates and retrieve only the selected credential      |
| `RoutingState`        | Atomically acquire, renew, record, release, and summarize routes |
| `UpstreamTransport`   | Execute the one permitted upstream transmission                  |
| `GatewayTelemetry`    | Emit bounded routing and bookkeeping events without payloads     |

`UsageProbe` defines the portable live-quota boundary. It is not yet connected to a scheduled
cache/refresh service; current candidates are decoded from bootstrap configuration.

Every expected error is typed. Runtime values, JSON, SQL rows, request payloads used for state RPC,
and encrypted envelopes are decoded with Effect Schema. Composition roots build named Layers once
inside `ManagedRuntime`.

## Request sequence

```text
client
  | 1. request headers
  v
authenticate
  | 2. method, path, explicit session
  v
RoutingState.acquire
  | 3. selected opaque account + lease
  v
AccountDirectory.credential
  | 4. secret injected after caller credentials are stripped
  v
UpstreamTransport.execute
  | 5. one request, no replay
  v
upstream / AI Gateway
  | 6. status recorded, response headers sanitized
  v
client <---- response bytes streamed unchanged
  |
  +---- lease renewed after each elapsed 40-second interval
  +---- lease released on end, cancellation, error, or empty body
```

The request body remains an unread `ReadableStream`. The response wrapper reads only to relay byte
chunks and manage the lease lifecycle. It does not decode SSE events, JSON, prompts, tool calls,
reasoning, summaries, compaction artifacts, or output.

## Selection

A candidate is ineligible if it:

- requires reauthentication;
- has an active quota or transient block;
- has no known usage;
- has usage older than 24 hours;
- has no future weekly reset;
- has less than 10% short-window or 3% weekly remaining quota.

Usage older than 60 seconds is stale but remains a fallback until 24 hours. Stale weekly headroom
receives a five-point penalty.

Eligible accounts are ordered by quota-expiry urgency:

```text
weekly remaining percent / max(0.25, hours until weekly reset)
```

This deliberately spends quota most at risk of expiring unused. A seven-day session assignment stays
on its current eligible account when its score is within 10% of the best candidate. Final ties use
weekly headroom, short-window headroom, active reservations, and opaque account ID.

Anonymous traffic is balanced but not assigned. Per-request round robin would destroy cache locality
and continuity, so it is not used.

## State

An atomic acquisition:

1. removes expired assignments and leases;
2. overlays recorded upstream health onto candidates;
3. selects with current active reservations;
4. inserts a 120-second lease;
5. upserts a seven-day assignment when an explicit session exists.

Response status changes health:

| Status    | Classification | State effect                                      |
| --------- | -------------- | ------------------------------------------------- |
| 2xx–3xx   | success        | clear transient health evidence                   |
| 401       | reauth         | mark account as requiring reauthentication        |
| 429       | quota          | quota block, using valid `Retry-After` when given |
| 403       | forbidden      | policy/workspace/origin evidence                  |
| 404       | not found      | model/account availability evidence               |
| other 4xx | client error   | do not punish the account as a provider failure   |
| 5xx       | transient      | temporary block evidence                          |

`Retry-After` may be numeric seconds or an HTTP date. It is response cooldown evidence, not a
replacement for live quota-window reset data.

### Bun state

The Bun adapter uses native SQLite and `BEGIN IMMEDIATE`. It is suitable for one process or one
Kubernetes replica with one persistent SQLite file. A shared multi-writer filesystem does not
provide the required database semantics.

### Cloudflare state

The Worker uses one SQLite Durable Object named `global`. It receives small internal HTTP RPCs for
acquire, renew, record, release, summary, and encrypted credential vault operations. The public
request body and upstream response never cross the object boundary.

Workers KV is not a substitute because assignment and lease changes require atomic read-modify-
write behavior.

## Protocol mapping

Five incoming paths are recognized:

| Incoming path           | API-key upstream        | Subscription upstream          |
| ----------------------- | ----------------------- | ------------------------------ |
| `/responses`            | `/v1/responses`         | `/backend-api/codex/responses` |
| `/v1/responses`         | `/v1/responses`         | `/backend-api/codex/responses` |
| `/codex/responses`      | `/v1/responses`         | `/backend-api/codex/responses` |
| `/responses/compact`    | `/v1/responses/compact` | `/backend-api/codex/responses` |
| `/v1/responses/compact` | `/v1/responses/compact` | `/backend-api/codex/responses` |

Native subscription compaction data is forwarded opaquely. WebSocket transport is outside the
initial contract.

## Cloudflare AI Gateway transport

API-key accounts use AI Gateway’s built-in OpenAI provider path. Subscription accounts use a custom
provider with the root `https://chatgpt.com`, allowing the provider-specific endpoint to append
`/backend-api/codex/responses` without translating the body.

Each request forces:

- cache off;
- payload storage off;
- maximum attempts equal to one;
- a Worker-held AI Gateway Run token;
- no more than five bounded metadata values.

AI Gateway `/compat`, semantic routing, Dynamic Routing, DLP, and response parsing are outside this
flow. Cloudflare documents the custom-provider URL mapping in
[Custom Providers](https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/).

## Current gap and intended next slice

The next production slice is a live `UsageProbe` cache and an OAuth refresh coordinator based on the
existing AgentOS implementation:

- refresh usage no more than once per account per 60 seconds;
- preserve the last valid snapshot with a maximum age of 24 hours;
- lock refresh per account;
- bind rejected responses to the credential generation that produced them;
- verify provider identity before replacing credential material;
- persist encrypted refresh material only in runtime adapters;
- expose no refresh material to `core`, candidates, status, or telemetry.

That slice must preserve the current portable service boundary instead of embedding Worker or
Kubernetes behavior in the policy.
