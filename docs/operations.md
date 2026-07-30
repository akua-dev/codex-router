# Operations

## Readiness

The subscription path has passed unit/integration gates, a deployed exact-byte synthetic SSE canary,
a live quota probe, and a minimal real Codex CLI Responses canary through Cloudflare AI Gateway and
the tunnel relay.

The safe operational classification is:

- technically deployable and verified for controlled subscription traffic;
- Workers Paid is the conservative Cloudflare plan because observed CPU is not consistently below
  the Free plan’s 10 ms invocation allowance;
- organizational approval remains required because multi-account ChatGPT OAuth pooling is not a
  documented OpenAI public API workflow;
- HTTP/SSE only; no WebSocket compatibility claim;
- one Bun writer replica per native SQLite database.

See [canary.md](canary.md) for dated evidence.

## Secret inventory

Keep every value in Wrangler secrets, Kubernetes Secrets/external secrets, or an organization secret
manager. Values must not enter Git, ConfigMaps, Pod annotations, image layers, URLs, or
shell-history arguments.

### Worker

| Binding                             | Purpose                                                      |
| ----------------------------------- | ------------------------------------------------------------ |
| `CODEX_ROUTER_CLIENT_TOKEN`         | Model ingress authentication                                 |
| `CODEX_ROUTER_ADMIN_TOKEN`          | Account admin and internal Durable Object RPC authentication |
| `CODEX_ROUTER_RELAY_TOKEN`          | AI Gateway-to-relay transport authentication                 |
| `CODEX_ROUTER_CREDENTIAL_KEYS_JSON` | Versioned AES-256-GCM keyring                                |
| `CF_AIG_ACCOUNT_ID`                 | AI Gateway account routing                                   |
| `CF_AIG_GATEWAY_ID`                 | AI Gateway identifier                                        |
| `CF_AIG_CUSTOM_PROVIDER_SLUG`       | Custom provider slug without `custom-`                       |
| `CF_AIG_TOKEN`                      | AI Gateway Run token                                         |
| `CODEX_ROUTER_ACCOUNTS_JSON`        | Optional bootstrap-only account array                        |

The client, admin, and relay tokens must all differ.

### Bun router

Required:

- `CODEX_ROUTER_CLIENT_TOKEN`
- `CODEX_ROUTER_ADMIN_TOKEN`

Optional:

- `CODEX_ROUTER_ACCOUNTS_JSON`, default `[]`;
- `CODEX_ROUTER_DATABASE_PATH`, default `./data/codex-router.sqlite`;
- `HOST`, default `0.0.0.0`;
- `PORT`, default `8787`.

### Relay

The relay needs only:

- `CODEX_ROUTER_RELAY_TOKEN`;
- `HOST`, default `0.0.0.0`;
- `PORT`, default `8788`.

The Cloudflare Tunnel sidecar consumes its own tunnel token. The committed Kubernetes deployment
expects:

- Secret `codex-router-egress` with keys `relay-token` and `tunnel-token`;
- image-pull Secret `codex-router-ghcr`.

Those Secret objects are intentionally not committed.

## Account bootstrap and administration

Routine account lifecycle uses the admin client:

```bash
export CODEX_ROUTER_ADMIN_URL=https://router.example
export CODEX_ROUTER_ADMIN_TOKEN=loaded-by-the-operator-secret-shell

bun run admin:bun list
bun run admin:bun login primary
bun run admin:bun disable primary
bun run admin:bun enable primary
bun run admin:bun remove primary
```

`login` starts OpenAI device authorization, polls with the provider-defined interval, verifies the
provider account identity embedded in the access token, and stores a new router generation.

`CODEX_ROUTER_ACCOUNTS_JSON` exists only for first deployment or recovery seeding. Existing accounts
are never overwritten by bootstrap input. Each item is a subscription credential and initial usage
snapshot:

| Field               | Constraint                               |
| ------------------- | ---------------------------------------- |
| `accountId`         | Stable opaque router-local identifier    |
| `accessToken`       | Current subscription access token        |
| `refreshToken`      | Current subscription refresh token       |
| `expiresAt`         | Access-token expiry epoch milliseconds   |
| `providerAccountId` | Provider identity for consistency checks |
| `observedAt`        | Quota observation epoch milliseconds     |
| `shortUsedPercent`  | Finite short-window percentage           |
| `shortResetAt`      | Short-window reset epoch milliseconds    |
| `weeklyUsedPercent` | Finite weekly-window percentage          |
| `weeklyResetAt`     | Weekly reset epoch milliseconds          |

After account import, maintenance refreshes quota every 60 seconds and refreshes credentials five
minutes before expiry. A weekly-only provider response remains valid; the router models the absent
short window as unused.

## Bun deployment

```bash
bun install --frozen-lockfile
bun run check
bun run start:bun
```

For Kubernetes:

- mount a persistent volume at the database parent directory;
- run one replica for that native SQLite file;
- use `GET /healthz` for liveness/readiness;
- protect ingress with TLS and network/access policy;
- allow graceful shutdown;
- source secrets through a Secret or external-secret controller.

`BunRuntime.runMain` launches the `BunHttpServer`/`HttpRouter` layer and installs signal-aware
shutdown. Effect filesystem/path services create the database directory, and the scoped maintenance
fiber repeats every minute until the launched layer is interrupted.

## Cloudflare deployment

### AI Gateway

Create one AI Gateway with:

- authentication enabled;
- request logs enabled;
- payload logging disabled;
- cache skipped;
- maximum attempts one;
- log management set to delete oldest entries at the account limit.

Create a custom provider whose base URL is the authenticated Cloudflare Tunnel hostname for the Bun
relay. Keep static custom-provider headers empty. The Worker adds the run token, relay token, cache,
payload, retry, and bounded metadata headers on every request.

Do not point the provider directly at `chatgpt.com`: the deployed direct-egress canary was rejected
upstream. Do not configure `x-api-key` as a static provider header; it would make rotation harder
and was not reliable in the tested custom-provider path.

### Worker bindings

Enter every binding through Wrangler stdin:

```bash
bunx wrangler secret put CODEX_ROUTER_CLIENT_TOKEN --config apps/worker/wrangler.jsonc
bunx wrangler secret put CODEX_ROUTER_ADMIN_TOKEN --config apps/worker/wrangler.jsonc
bunx wrangler secret put CODEX_ROUTER_RELAY_TOKEN --config apps/worker/wrangler.jsonc
bunx wrangler secret put CODEX_ROUTER_CREDENTIAL_KEYS_JSON --config apps/worker/wrangler.jsonc
bunx wrangler secret put CF_AIG_ACCOUNT_ID --config apps/worker/wrangler.jsonc
bunx wrangler secret put CF_AIG_GATEWAY_ID --config apps/worker/wrangler.jsonc
bunx wrangler secret put CF_AIG_CUSTOM_PROVIDER_SLUG --config apps/worker/wrangler.jsonc
bunx wrangler secret put CF_AIG_TOKEN --config apps/worker/wrangler.jsonc
```

Generate each AES key as 32 random bytes encoded with unpadded base64url. The keyring is:

```json
{
  "currentVersion": "v2",
  "keys": {
    "v1": "base64url-encoded-32-byte-key",
    "v2": "base64url-encoded-32-byte-key"
  }
}
```

Keep the source keyring and recovery procedure in the organization secret manager before importing
accounts. Loss of every version used by stored ciphertext makes those credentials unrecoverable.

Deploy:

```bash
bun install --frozen-lockfile
bun run check
bun run deploy:worker
```

The checked-in Cloudflare migration creates the SQLite-backed `RouterStateObject`. Inside it, the
official Effect SQL migrator applies ordered, non-destructive migrations and records them in
`effect_sql_migrations`. Treat the Durable Object class name, namespace, migration IDs/names, and
logical table names as persistent storage identifiers. Never renumber an applied migration or reuse
an ID for different SQL.

The cron trigger runs every minute. A scheduled event creates a request-scoped application, runs
portable maintenance, then disposes the runtime.

### Relay deployment

Build and push the pinned Bun image, update its immutable GHCR digest in
`deploy/kubernetes/relay/deployment.yaml`, then:

```bash
kubectl apply -k deploy/kubernetes/relay
kubectl -n codex-router rollout status deployment/codex-router-egress
```

The deployment has:

- no service-account token;
- non-root UID/GID 1000;
- read-only root filesystems and no Linux capabilities;
- CPU/memory requests and limits;
- no ingress from the cluster;
- egress only to DNS plus TCP 443 and 7844;
- a pinned relay image and pinned `cloudflared` digest;
- HTTP/2 tunnel transport because the cluster path permits TCP 7844.

The tunnel’s remotely managed ingress points to `http://localhost:8788`; all unmatched routes
return 404.

## Credential-key rotation

Rotation is online and lazy-on-use:

1. generate a new 32-byte key under a never-used version;
2. add it to `keys` while retaining every version reported by `GET /admin/key-versions`;
3. set it as `currentVersion` and update the Worker secret;
4. deploy/restart the Worker;
5. allow maintenance and traffic to decrypt each enabled account; decryption rewrites that record
   with a fresh nonce under the current key;
6. query `GET /admin/key-versions` with the admin token until the old version count is zero;
7. explicitly exercise disabled accounts or re-import them before retirement, because routine
   maintenance skips disabled credentials;
8. remove the old key only after all ciphertext moved and the rollback window is approved;
9. deploy and verify account list, live usage, synthetic SSE, and one controlled model request.

Never reuse one version string with different key bytes. Never remove a key while its reported count
is nonzero.

Rotate the router client token, admin token, AI Gateway Run token, relay token, tunnel token, and
registry pull credential independently. The current client/admin ingress accepts one generation at a
time, so coordinate client cutover.

## Canary procedure

Run the synthetic deployed test without printing tokens:

```bash
CODEX_ROUTER_URL=https://router.example \
CODEX_ROUTER_ADMIN_TOKEN=loaded-by-the-operator-secret-shell \
bun run canary:synthetic
```

It requires:

- one HTTP request;
- status 200;
- exactly 62 expected bytes;
- a first-byte timestamp earlier than completion;
- no response payload in its report.

Inspect one AI Gateway record with:

```bash
CF_ACCOUNT_ID=loaded-from-cloudflare \
CF_AIG_GATEWAY_ID=loaded-from-cloudflare \
CLOUDFLARE_API_TOKEN=loaded-by-the-operator-secret-shell \
bun run canary:inspect
```

The inspector prints only sanitized status/path/cache/timing metadata and stored payload lengths.
All prompt, request, and response stored lengths must be zero.

For a real canary, use a minimal Codex CLI prompt that has a deterministic tiny answer. Confirm:

- the response completes once;
- account generation remains current;
- active reservations return to zero;
- live usage advances;
- the corresponding AI Gateway record has payload lengths zero;
- no Worker or relay log contains headers, credentials, or model content.

Do not run a full-header live tail while sending model/admin traffic.

## Capacity

The 2026-07-30 audit reconstructed completed calls from local Codex rollout JSONL and AgentOS homes:

| Evidence                                              |     Count |
| ----------------------------------------------------- | --------: |
| Local rollout files                                   |     8,028 |
| Raw local terminal completion/token records           | 1,993,486 |
| Deduplicated inferred local completed calls           |   570,364 |
| Remote live AgentOS calls, July 21–30                 |   ~15,219 |
| Local OrbStack AgentOS calls                          |     1,349 |
| Known combined lower bound                            |  ~586,932 |
| Scaled-to-zero AgentOS PVCs not mounted for the audit |        20 |

Recent profile:

| Measure                     |      Observed |
| --------------------------- | ------------: |
| Last nine complete UTC days | 105,034 calls |
| Average complete day        |  11,670 calls |
| Peak complete day           |  24,657 calls |
| Peak minute                 |     117 calls |
| Peak second                 |       9 calls |
| Remote-cluster peak day     |  ~3,249 calls |

This is a lower bound. Missing terminal records and the unmounted PVCs can increase reality;
resume/fork deduplication is inferential.

### Workers and Durable Objects

At the observed peak:

```text
model Worker requests                         24,657/day
minute scheduled events                        1,440/day
projected Worker invocations                  26,097/day

normal DO calls = acquire + record + release       3/model call
normal model DO calls                         73,971/day
minute maintenance DO calls                    1,440/day
projected baseline DO requests                75,411/day
remaining before 100,000/day                  24,589/day
```

Long streams add one DO renewal per elapsed 40-second interval. Status, admin, failed acquisition,
and canary traffic also consume capacity. Rows read/write remain well below the published five
million reads/day and 100,000 writes/day in the measured canary, but production telemetry must
confirm the distribution.

The request-count dimensions fit the Free allowances at the observed lower-bound peak.

The CPU dimension does not have the same verdict. The final post-deploy smoke recorded four
successful invocations with 50.752 ms total CPU (12.688 ms/invocation average); its minute p50 was
14.636–19.950 ms and p99 was 15.047–19.950 ms. The fuller real-canary window immediately before the
release cleanup recorded nine successful invocations with 187.188 ms total CPU (20.80 ms average)
and minute p99 values up to 46.481 ms. The Free allowance is 10 ms CPU per invocation. Cloudflare
permits some infrequent flexibility, but these traces do not establish Free-tier safety. Use Workers
Paid or repeat a representative production CPU study after optimization.

### AI Gateway

The observed 9 requests/second peak is far below AI Gateway’s 500 stored logs/second limit. The
100,000-log storage allowance is the tighter bound:

```text
model logs/day at recent average      11,670
usage logs/day per enabled account     1,440
one enabled account total             13,110 -> about 7.6 days
two enabled accounts total            14,550 -> about 6.9 days
```

The deployed gateway is configured to delete the oldest logs at the limit. Use Logpush/export if a
longer metadata history is required; never enable payload storage for that purpose.

### Verdict

- Request volume fits Workers Free.
- Baseline DO request volume fits Free with about 24.6% headroom before renewals/admin traffic.
- AI Gateway ingress fits; log retention is days, not months.
- Observed Worker CPU does not justify a Free-tier guarantee.
- The Kubernetes relay consumes separate cluster resources and is not part of Workers Free.

## Monitoring

Alert on:

- Worker invocation errors, error 1102, CPU p50/p95/p99, and memory/startup regressions;
- daily Worker and DO request allowance consumption;
- Durable Object exceeded CPU/memory errors, rows written, and persistent reservation counts;
- `no_eligible_account`, upstream-unavailable, and credential-unavailable rates;
- reauthentication state, quota blocks, and generation churn by opaque account ID;
- quota observation age above 60 seconds or approaching 24 hours;
- AI Gateway cache/payload/retry/auth configuration drift;
- gateway log retention and deletion/export health;
- relay/tunnel availability and unexpected rejected paths.

Never attach session keys, provider identity, credentials, headers, prompts, or model output as
labels or logs.

## Backup, restore, and rollback

### Bun

Use SQLite’s online backup API or an application-consistent CSI VolumeSnapshot. Record the source
commit and schema version. Restore into an isolated one-replica deployment and verify account
generation, usage freshness, assignment cleanup, sanitized status, and login/refresh behavior.

Unlike the earlier bootstrap-only design, the Bun account database contains subscription credential
material. Protect backups as credentials and encrypt them at rest.

### Cloudflare

Durable Object storage is platform-managed. Recovery depends on:

- retrievable OAuth refresh sources or repeatable device login;
- every active credential-encryption key version;
- Worker secret inventory;
- tunnel and Kubernetes secret inventory;
- immutable code/image versions.

Never export decrypted vault rows into an artifact.

For a Worker code rollback:

```bash
bunx wrangler deployments list --config apps/worker/wrangler.jsonc
bunx wrangler rollback --config apps/worker/wrangler.jsonc
```

Verify migration compatibility before rollback. Do not delete a Durable Object namespace as a
rollback mechanism. After rollback, run health, status, synthetic SSE, usage, and privacy checks.

For the relay, update the manifest to a previously verified immutable image digest, apply it, and
wait for rollout. Do not roll back to a relay that lacks SSE encapsulation while AI Gateway still
mutates JSON SSE.
