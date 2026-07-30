# codex-router

`codex-router` is an Effect-first, quota-aware load balancer for Codex Responses traffic. It keeps
sessions sticky to healthy accounts, accounts for concurrent streams, forwards each request once,
and preserves the upstream HTTP/SSE response. The same domain code runs on Cloudflare Workers or on
Bun in a VM or Kubernetes cluster.

Cloudflare AI Gateway is an optional observability hop in the Worker runtime. It records bounded
metadata while payload storage, caching, and retries are disabled for every request. It does not
know ChatGPT subscription quota and does not choose the account.

## Status

This repository is a tested foundation, not a production-ready subscription pool.

Working now:

- deterministic short-window and weekly-quota selection;
- seven-day session affinity with 10% hysteresis;
- atomic leases and response-health state in SQLite;
- transparent HTTP and SSE forwarding for five observed Responses paths;
- Cloudflare Worker plus SQLite Durable Object composition;
- encrypted Worker credential persistence using AES-256-GCM;
- portable Bun server composition for AgentOS and other Kubernetes deployments;
- privacy-safe Cloudflare AI Gateway request metadata.

Release blockers:

- the account snapshots in `CODEX_ROUTER_ACCOUNTS_JSON` are static at process/Worker bootstrap;
- access-token refresh and generation-safe refresh locking are not implemented;
- deployed Cloudflare CPU and byte-identical SSE canaries have not run;
- multi-user ChatGPT OAuth pooling is not a documented OpenAI public API workflow and requires
  terms, privacy, and organization-policy review.

OpenAI documents that Codex is included with ChatGPT plans, but it also documents that API billing
is separate from ChatGPT. There is no documented “Codex subscription API key.” Cloudflare’s official
Codex integration uses AI Gateway Unified Billing, not a ChatGPT subscription. See
[Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-chatgpt),
[ChatGPT and API billing](https://help.openai.com/en/articles/8156019-is-api-usage-included-in-chatgpt-subscriptions-even-if-i-have-a-paid-chatgpt-account),
and
[Cloudflare’s Codex integration](https://developers.cloudflare.com/ai-gateway/integrations/coding-agents/openai-codex/).

## Architecture

```text
Codex or Pi client
        |
        | authenticated Responses request
        v
portable Effect handler (packages/core + packages/codex)
        |
        +---- acquire / record / release ----> atomic RoutingState
        |                                     Worker: SQLite Durable Object
        |                                     Bun: native SQLite
        |
        +---- selected credential -----------> runtime credential adapter
        |
        +---- one opaque streaming fetch ----> Cloudflare AI Gateway ----> upstream
                                               metadata only
```

Model request and response bodies never enter the Durable Object, the routing database, or
application logs. `packages/core` and `packages/codex` contain no Bun, Node, Wrangler, or Cloudflare
imports.

## Supported routes

The router accepts `POST` on:

- `/responses`
- `/v1/responses`
- `/codex/responses`
- `/responses/compact`
- `/v1/responses/compact`

It also exposes:

- `GET /healthz`, unauthenticated liveness only;
- `GET /status`, authenticated routing counts and sanitized account health.

Authenticate with `x-ai-router-token` or `Authorization: Bearer …`. Explicit session identifiers are
read from known Codex or gateway session headers; anonymous requests are not made sticky from IP
addresses, user agents, credentials, or prompt contents.

The initial contract is HTTP only. WebSocket routing is intentionally not advertised.

## Account configuration

Both runtimes decode `CODEX_ROUTER_ACCOUNTS_JSON` as a non-empty JSON array. Each item has:

| Field               | Type                                     | Meaning                                   |
| ------------------- | ---------------------------------------- | ----------------------------------------- |
| `accountId`         | string                                   | Opaque router-local identity              |
| `kind`              | `codex_subscription` or `openai_api_key` | Upstream credential adapter               |
| `accessToken`       | string                                   | Secret credential material                |
| `providerAccountId` | optional string                          | Provider identity required by the adapter |
| `observedAt`        | Unix epoch milliseconds                  | Time of the quota observation             |
| `shortUsedPercent`  | number                                   | Used percentage in the short window       |
| `shortResetAt`      | Unix epoch milliseconds                  | Short-window reset                        |
| `weeklyUsedPercent` | number                                   | Used percentage in the weekly window      |
| `weeklyResetAt`     | Unix epoch milliseconds                  | Weekly reset                              |

Build this JSON out of band in a secret manager. Do not commit it. Until live quota refresh lands,
replace and restart before snapshots reach 24 hours old; data older than 60 seconds is already
treated as a penalized fallback.

## Run with Bun

Requirements are Bun and a secret source that can populate the required environment:

```bash
bun install --frozen-lockfile
bun run check
bun run start:bun
```

Required environment:

- `CODEX_ROUTER_CLIENT_TOKEN`
- `CODEX_ROUTER_ACCOUNTS_JSON`

Optional environment:

- `CODEX_ROUTER_DATABASE_PATH`, default `./data/codex-router.sqlite`
- `HOST`, default `0.0.0.0`
- `PORT`, default `8787`

Use one Bun replica per SQLite file. A normal Kubernetes SQLite PVC is not a shared multi-writer
database.

## Run on Cloudflare

Create an AI Gateway and, for experimental subscription traffic, a custom provider whose base URL is
`https://chatgpt.com`. Cloudflare requires the `custom-` prefix at request time; configure
`CF_AIG_CUSTOM_PROVIDER_SLUG` without that prefix. The implementation uses the provider-specific
endpoint because the Codex backend path is not the OpenAI-compatible chat-completions shape.

Set bindings through Wrangler’s interactive secret command so values do not enter shell history:

```bash
bunx wrangler secret put CODEX_ROUTER_CLIENT_TOKEN --config apps/worker/wrangler.jsonc
bunx wrangler secret put CODEX_ROUTER_ACCOUNTS_JSON --config apps/worker/wrangler.jsonc
bunx wrangler secret put CF_AIG_ACCOUNT_ID --config apps/worker/wrangler.jsonc
bunx wrangler secret put CF_AIG_GATEWAY_ID --config apps/worker/wrangler.jsonc
bunx wrangler secret put CF_AIG_CUSTOM_PROVIDER_SLUG --config apps/worker/wrangler.jsonc
bunx wrangler secret put CF_AIG_TOKEN --config apps/worker/wrangler.jsonc
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' | bunx wrangler secret put CODEX_ROUTER_CREDENTIAL_KEY --config apps/worker/wrangler.jsonc
```

Then:

```bash
bun run dev:worker
bun run build:worker
bun run deploy:worker
```

The checked-in Wrangler configuration creates one SQLite Durable Object class and names the
coordination object `global`. Read the deployed-canary requirements in
[`docs/operations.md`](docs/operations.md) before directing real model traffic to it.

## Packages

- `@akua-dev/codex-router-core`: domain schemas, selection, state port, response classification;
- `@akua-dev/codex-router-codex`: protocol, auth/session logic, ports, transparent handler;
- `@akua-dev/codex-router-bun`: native SQLite and Bun runtime layers;
- `@akua-dev/codex-router-cloudflare`: Durable Object, encrypted vault, AI Gateway transport;
- `apps/server`: Bun composition root;
- `apps/worker`: Cloudflare composition root.

The official Effect agent skill is vendored in `.agents/skills/effect-ts`, and the matching Effect
source is pinned as `.repos/effect`. Read [`AGENTS.md`](AGENTS.md) before modifying the project.

## Verification

```bash
bun run check
git diff --check
```

The gate formats, lints, type-checks, runs the Effect/Vitest suites, and performs a Wrangler
deployment dry run.

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — dependency direction, data flow, and invariants
- [`docs/operations.md`](docs/operations.md) — deployment, capacity, canary, backup, and rollback
- [`docs/research.md`](docs/research.md) — verified alternatives, request audit, and platform limits
- [`docs/security.md`](docs/security.md) — threat model, controls, gaps, and incident handling

## License

MIT
