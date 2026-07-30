# Deployed canary evidence

Evidence date: 2026-07-30. Times are UTC.

This document records deployment evidence without model payloads, prompts, credentials, provider
account identities, or human account identifiers.

## Path under test

```text
Codex / synthetic client
  -> codex-router Worker
  -> Cloudflare AI Gateway custom provider
  -> Cloudflare Tunnel
  -> Bun egress relay
  -> synthetic fixture or chatgpt.com
```

Current production Worker version under the final synthetic canary:
`d7e1b929-9196-42df-a1b0-cfbbaf228826`.

Relay image under the recorded canaries:
`ghcr.io/akua-dev/codex-router-relay@sha256:83d6a388dc003cd50d3734be96bf79274f36fc061fff530c24431a2e66a0fd17`.

This release runs the portable HTTP application on Effect HTTP, the relay and standalone service on
the official Bun runtime/server/platform layers, Durable Object persistence on the official Effect
SQLite client and migrator, and both Bun repositories on a shared official Effect SQLite client.

## Synthetic SSE

The relay emitted a controlled three-chunk fixture:

- a UTF-8 wave character split across two chunks;
- two JSON SSE events;
- one `[DONE]` event;
- 50 ms delay between chunks;
- 62 expected bytes total.

The deployed Worker canary made exactly one request and received:

```json
{
  "bytes": 62,
  "firstByteMs": 487.52549999999997,
  "requestCount": 1,
  "status": 200,
  "totalMs": 586.5805
}
```

The client’s bytes matched the fixture exactly and the first byte arrived before completion.

AI Gateway log `01KYT0BDZJ33W38W9GVQ572YC4` recorded:

- timestamp `2026-07-30T17:15:02.034Z`;
- status 200;
- custom-provider path ending in `/synthetic/sse`;
- duration 275 ms;
- cache miss / not cached;
- metadata `protocol=responses`, `runtime=cloudflare`;
- stored request length 0;
- stored response length 0;
- stored prompt length 0.

## AI Gateway SSE mutation finding

Before transport encapsulation, the same 62-byte fixture arrived from AI Gateway as 98–102 bytes. AI
Gateway had inserted random `nonce` properties into both JSON SSE data events. Disabling gateway
payload logging did not stop the transformation.

After the relay carried the body as `application/octet-stream` and the Worker restored
`text/event-stream` from a controlled header, the exact 62 bytes arrived unchanged. Regression tests
cover relay encapsulation, Worker restoration, UTF-8 split preservation, and one-request behavior.

## Live quota

A current local ChatGPT subscription credential was imported through the authenticated admin surface
as one opaque router account. Its router generation advanced during repeated controlled imports,
proving replacement is monotonic.

The live usage endpoint completed through AI Gateway, Tunnel, and relay. The observed provider shape
had:

- a valid seven-day primary window;
- `secondary_window: null`;
- string-encoded credit balance.

The decoder accepted that known weekly-only shape, rejected malformed/unknown duration shapes, and
persisted a fresh usage observation for the current credential generation. The account remained
enabled and did not require reauthentication.

## Minimal real Codex response

A Codex CLI custom provider was configured on Worker version `d7e1b929-9196-42df-a1b0-cfbbaf228826`
with:

- router authentication from an environment-backed header;
- normal Codex subscription authentication semantics;
- no retries;
- the local Codex model catalog;
- a minimal deterministic prompt.

The final canary returned exactly `OK`, once, with no CLI error.

The final canary exercises the released Effect HTTP/SQL/Clock/Crypto runtime and the rebuilt
Effect/Bun relay pair.

AI Gateway log `01KYT0FMSFCW9XVHS4KKRFWMXF` recorded:

- timestamp `2026-07-30T17:17:21.970Z`;
- status 200;
- custom-provider path ending in `/backend-api/codex/responses`;
- duration 2,182 ms;
- not cached;
- metadata `protocol=responses`, `runtime=cloudflare`;
- stored request length 0;
- stored response length 0;
- stored prompt length 0.

After completion, sanitized router status showed:

- zero active reservations;
- no block on the selected opaque account;
- no reauthentication requirement;
- live usage on the current credential generation.

## Worker and Durable Object telemetry

Cloudflare GraphQL Analytics was queried through the Cloudflare MCP/API connection.

The current production Worker version recorded this deploy, synthetic, real-response, status, and
maintenance smoke:

| Minute | Successful invocations |   CPU sum |   CPU p50 |   CPU p99 | Subrequests |
| ------ | ---------------------: | --------: | --------: | --------: | ----------: |
| 17:14  |                      1 | 24.592 ms | 24.592 ms | 24.592 ms |           1 |
| 17:15  |                      3 | 99.649 ms | 32.407 ms | 39.389 ms |           3 |
| 17:16  |                      1 | 17.651 ms | 17.651 ms | 17.651 ms |           1 |
| 17:17  |                      3 | 75.242 ms | 24.135 ms | 38.846 ms |           6 |

All eight invocations succeeded with zero runtime errors. Their aggregate CPU was 217.134 ms, or
27.142 ms per invocation. Peak observed p99 was 39.389 ms.

For the current version’s `global` Durable Object, the same window recorded nine successful
invocations with zero errors. Periodic telemetry recorded 97.646 ms CPU, 69 rows read, 19 rows
written, two subrequests, zero exceeded-CPU errors, and zero fatal-internal errors.

The fuller real-canary Worker version `4ba697b0-f6f2-47ed-8232-2016cfd8dc58` recorded:

| Minute | Successful invocations |    CPU sum |   CPU p50 |   CPU p99 | Subrequests |
| ------ | ---------------------: | ---------: | --------: | --------: | ----------: |
| 15:10  |                      2 |  34.197 ms | 13.009 ms | 21.188 ms |           2 |
| 15:11  |                      5 | 130.373 ms | 20.199 ms | 46.481 ms |           8 |
| 15:12  |                      2 |  22.618 ms |  5.670 ms | 16.948 ms |           2 |

All nine recorded invocations succeeded with zero runtime errors. Their aggregate CPU was 187.188
ms, or 20.80 ms per invocation. This mixed window contains canary, status/control, and scheduled
activity, so it is release evidence rather than a model-only benchmark.

For the `global` Durable Object in that fuller window:

| Minute | Requests |   CPU sum | Rows read | Rows written | Subrequests | Exceeded CPU |
| ------ | -------: | --------: | --------: | -----------: | ----------: | -----------: |
| 15:10  |        1 | 12.356 ms |        10 |            5 |           1 |            0 |
| 15:11  |        4 | 39.776 ms |        25 |           11 |           1 |            0 |
| 15:12  |        2 |  6.785 ms |        16 |            0 |           0 |            0 |
| 15:13  |        1 |  9.266 ms |        10 |            5 |           1 |            0 |

There were no Durable Object fatal internal errors in these groups. CPU and row figures come from
Cloudflare’s adaptive/periodic datasets and are subject to its documented analytics aggregation and
sampling behavior.

The earlier post-deploy Durable Object smoke added two successful requests, 24.740 ms periodic CPU,
27 rows read, five rows written, one subrequest, and zero exceeded-CPU or fatal-internal errors.

## Result

The deployed path proves:

- subscription OAuth credentials can be administered and refreshed generation-safely;
- live quota can traverse AI Gateway through the fixed-route relay;
- model Responses traffic can complete through the same path;
- client-visible SSE remains incremental and byte-exact;
- one provider attempt, cache bypass, and payload-free logging are effective;
- reservations are released;
- observed request counts fit Free allowances, but observed Worker CPU does not establish the 10 ms
  Free-tier limit.
