# Operations

## Readiness classification

The repository can be built, tested, and exercised with controlled traffic. It is not ready for
unattended subscription pooling because live quota refresh, OAuth refresh, credential-generation
locking, deployed Worker CPU measurements, deployed SSE verification, and policy review remain open
release gates.

Standard OpenAI API-key forwarding does not remove the live-quota limitation: configured usage
snapshots still age out.

## Configuration

Create the account array in a secret manager, not in this repository or a shell-history command.
Every account item requires:

| Field               | Constraint                                         |
| ------------------- | -------------------------------------------------- |
| `accountId`         | Stable opaque non-human identifier                 |
| `kind`              | `codex_subscription` or `openai_api_key`           |
| `accessToken`       | Current upstream secret                            |
| `providerAccountId` | Present only when the upstream adapter requires it |
| `observedAt`        | Epoch milliseconds                                 |
| `shortUsedPercent`  | Finite used percentage                             |
| `shortResetAt`      | Future epoch milliseconds                          |
| `weeklyUsedPercent` | Finite used percentage                             |
| `weeklyResetAt`     | Future epoch milliseconds                          |

The decoder rejects an empty array and malformed structures. Operators must additionally ensure
percentages and timestamps came from the intended provider account. Current code treats snapshots
older than 60 seconds as stale and rejects them after 24 hours.

## Bun deployment

Required secret environment:

- `CODEX_ROUTER_CLIENT_TOKEN`
- `CODEX_ROUTER_ACCOUNTS_JSON`

Runtime settings:

- `CODEX_ROUTER_DATABASE_PATH`, default `./data/codex-router.sqlite`;
- `HOST`, default `0.0.0.0`;
- `PORT`, default `8787`.

Start:

```bash
bun install --frozen-lockfile
bun run check
bun run start:bun
```

For Kubernetes:

- inject required values from a Secret or external secret provider;
- mount a persistent volume at the parent of `CODEX_ROUTER_DATABASE_PATH`;
- deploy one replica while native SQLite is the state implementation;
- use `GET /healthz` for liveness;
- protect ingress with TLS and a separate network/access policy;
- give termination enough time for the Bun server’s graceful stop;
- never put the account JSON in a ConfigMap, Pod annotation, command argument, or rendered Helm
  output.

The repository deliberately does not include a generic Kubernetes manifest because storage, ingress,
and secret-manager choices belong to AgentOS. AgentOS should import the packages and provide its
existing live quota/vault layers instead of duplicating policy.

## Cloudflare deployment

### Prerequisites

- a Cloudflare account with Workers, SQLite Durable Objects, and AI Gateway;
- one AI Gateway;
- an AI Gateway Run token;
- a custom provider rooted at `https://chatgpt.com` only if experimental subscription traffic is
  being evaluated;
- all terms and data reviews required by the account owner.

Cloudflare custom-provider slugs are configured without `custom-` in `CF_AIG_CUSTOM_PROVIDER_SLUG`;
the transport adds the required prefix.

### Bindings

Use Wrangler’s interactive secret input:

```bash
bunx wrangler secret put CODEX_ROUTER_CLIENT_TOKEN --config apps/worker/wrangler.jsonc
bunx wrangler secret put CODEX_ROUTER_ACCOUNTS_JSON --config apps/worker/wrangler.jsonc
bunx wrangler secret put CF_AIG_ACCOUNT_ID --config apps/worker/wrangler.jsonc
bunx wrangler secret put CF_AIG_GATEWAY_ID --config apps/worker/wrangler.jsonc
bunx wrangler secret put CF_AIG_CUSTOM_PROVIDER_SLUG --config apps/worker/wrangler.jsonc
bunx wrangler secret put CF_AIG_TOKEN --config apps/worker/wrangler.jsonc
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' | bunx wrangler secret put CODEX_ROUTER_CREDENTIAL_KEY --config apps/worker/wrangler.jsonc
```

`CODEX_ROUTER_CREDENTIAL_KEY` must decode from base64url to exactly 32 bytes. Store the source key
and its recovery procedure in the organization secret manager before deployment. Losing the only key
makes the Durable Object vault unreadable.

### Build and deploy

```bash
bun install --frozen-lockfile
bun run check
bun run deploy:worker
```

The Wrangler migration creates the SQLite-backed `RouterStateObject`. Do not change its class name,
namespace, or migration history casually; treat those as storage schema identifiers.

## Deployed canary

Local tests and `wrangler dev` are necessary but insufficient. Before real traffic:

1. Confirm an unauthenticated request is rejected before a body source is read.
2. Confirm all five supported paths reach the expected upstream URL.
3. Send a deliberately chunked SSE response through a controlled upstream.
4. Compare chunk bytes, ordering, status, status text, and safe headers at the client.
5. Measure time to first byte and confirm the response arrives incrementally.
6. Cancel a stream and verify active reservations return to zero.
7. Run a stream longer than 40 seconds and verify bounded renewals.
8. Confirm a fast stream causes only acquire, record, and release state operations.
9. Return controlled 401, 429 with both `Retry-After` forms, 403, 404, and 5xx responses; inspect
   sanitized `/status`.
10. Confirm AI Gateway shows metadata and token/latency fields but no prompt or response payload.
11. Confirm cache is skipped and the maximum provider attempt count is one.
12. Inspect Worker CPU time, startup behavior, error 1102 counts, Durable Object requests, rows
    read/written, and duration.
13. Repeat under observed peak concurrency and with abrupt client disconnects.

Cloudflare has a documented Miniflare response-buffering issue, so an incremental local result
cannot prove deployed behavior; see
[workers-sdk issue 8004](https://github.com/cloudflare/workers-sdk/issues/8004).

## Capacity baseline

The July 30, 2026 lower-bound audit found:

| Source                      | Inferred completed calls |
| --------------------------- | -----------------------: |
| Local Codex rollout history |                  570,364 |
| Remote live AgentOS homes   |                   15,219 |
| Local OrbStack AgentOS      |                    1,349 |
| Known combined lower bound  |                  586,932 |

Twenty scaled-to-zero remote AgentOS StatefulSets had unmounted 20 GiB PVCs and are not in that
total.

Recent operating profile:

| Measure                     | Observed value |
| --------------------------- | -------------: |
| Last nine complete UTC days |  105,034 calls |
| Average per complete day    |   11,670 calls |
| Peak complete day           |   24,657 calls |
| Peak minute                 |      117 calls |
| Peak second                 |        9 calls |
| Remote-cluster peak day     |   ~3,249 calls |

### Free-tier fit

Cloudflare’s current Workers Free limit is 100,000 requests/day and 10 ms CPU/request. The observed
peak would consume 24.657% of the request allowance. Network wait does not count as Worker CPU, but
Effect orchestration, authentication, Schema work, Web Streams, and logging do. Only a deployed
canary can establish CPU fit. See
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

SQLite Durable Objects currently allow 100,000 requests/day on Free. A normal completed call uses
three object requests:

```text
acquire + record response + release = 3
24,657 × 3 = 73,971 object requests on the observed peak day
```

That is 73.971% before streams longer than 40 seconds add renewals. Free also currently includes
13,000 GB-s/day, five million rows read/day, 100,000 rows written/day, and 5 GB total SQLite
storage. State-request count is the first expected DO ceiling, but row and duration telemetry must
also be watched. See
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

AI Gateway currently accepts 500 stored logs/second per gateway and stores 100,000 logs total on
Free across the account. The observed 9/second peak is far below ingress, but at 11,670/day the
stored-log allowance fills in about 8.6 days. Configure automatic deletion or Logpush before
assuming continuous dashboard history. See
[AI Gateway limits](https://developers.cloudflare.com/ai-gateway/reference/limits/).

Free-tier verdict: the measured request volume fits Worker requests and likely AI Gateway ingress;
normal DO requests fit with limited headroom. Worker CPU, long-stream renewal distribution, stored
log retention, and the uncounted PVCs prevent a guarantee.

## Monitoring

Alert on:

- Worker 5xx, error 1102, CPU p95/p99, and startup regressions;
- request count approaching the daily account allowance;
- Durable Object requests, duration, rows written, and failures;
- `no_eligible_account`, `credential_unavailable`, and `upstream_unavailable`;
- account reauthentication state and quota/transient blocks;
- active reservations that persist beyond lease TTL;
- AI Gateway payload collection becoming enabled;
- AI Gateway retry/cache settings diverging from the per-request contract;
- quota snapshots older than 60 seconds and any approaching 24 hours;
- upstream 401 and 429 rate by opaque account ID.

Keep dimensions bounded. Never attach session values, provider account identities, prompt fields, or
credentials.

## Backup and restore

### Bun

Use the SQLite online backup API or a Kubernetes CSI VolumeSnapshot that is known to be
application-consistent. Record the application commit and schema version with the backup. Test
restore into an isolated one-replica deployment and verify:

- assignments and reservations decode;
- expired leases are cleaned on acquisition;
- `/status` remains sanitized;
- no credential material exists in the database.

Account credentials live outside this database and must be backed up by the secret manager.

### Cloudflare

Durable Object storage is platform managed. Build operational recovery around code versions,
encrypted credential source material, and reproducible account configuration. Before a storage
migration, export only sanitized routing state if the platform APIs and policy allow it. Do not
export decrypted vault records into deployment artifacts.

## Rollback

For a Worker code regression:

1. stop new traffic at the client or access layer if confidentiality or duplicate-send behavior is
   in doubt;
2. inspect available deployments with Wrangler;
3. run Wrangler’s interactive rollback using the checked-in config;
4. verify the resulting deployment and execute the authentication, SSE, and AI Gateway privacy
   canaries;
5. verify the Durable Object migration is compatible with the rolled-back code.

```bash
bunx wrangler deployments list --config apps/worker/wrangler.jsonc
bunx wrangler rollback --config apps/worker/wrangler.jsonc
```

Do not attempt to roll back a Durable Object storage migration by deleting the namespace. For Bun,
deploy the prior tested artifact against a compatible database; restore a verified backup only when
the schema or data itself is damaged.

## Routine update checklist

- refresh dated Cloudflare limits and recompute capacity;
- rerun the rollout/PVC request audit;
- update bootstrap quota data before it ages out;
- review account ownership and provider identity;
- run `bun run check` and the deployed canary;
- inspect AI Gateway retention, payload, cache, retry, and auth settings;
- verify the secret manager can recover every required binding;
- verify the remote Git commit matches the deployed source.
