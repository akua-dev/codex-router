# codex-router

`codex-router` is an Effect-first load balancer for Codex traffic backed by ChatGPT subscriptions.
It selects from live short/weekly quota state, preserves session affinity, refreshes OAuth
credentials safely, forwards every model request once, and streams the upstream response without
inspecting its body.

The routing core is runtime-neutral. The production composition runs on Cloudflare Workers with a
SQLite Durable Object; the same services run on Bun with native SQLite for AgentOS, VMs, and
Kubernetes.

This project is deliberately subscription-only. It does not accept OpenAI API keys, use API billing,
or pretend that a ChatGPT plan creates a “Codex API key.”

## Current state

Implemented and tested:

- live Codex usage probing with 60-second freshness and 24-hour maximum age;
- weekly-only and short-plus-weekly provider response shapes;
- OAuth device login and refresh-token rotation;
- generation-safe refresh claims, usage commits, and 401 handling;
- atomic account selection, leases, health, and seven-day session affinity;
- encrypted multi-version credential storage and online key rotation on Cloudflare;
- authenticated account list/login/enable/disable/remove administration;
- scheduled maintenance every minute on Workers and with an Effect schedule on Bun;
- one-send opaque HTTP/SSE forwarding;
- Cloudflare AI Gateway metadata logging with payloads, cache, and retries disabled;
- a narrowly scoped Bun egress relay behind Cloudflare Tunnel;
- byte-exact deployed synthetic SSE and minimal real Codex subscription canaries.

The deployed path is operationally validated. The remaining non-code decision is organizational:
multi-account ChatGPT OAuth pooling is not documented as an OpenAI public API workflow. Review
applicable terms, privacy rules, account ownership, and organization policy before widening use.

OpenAI documents that Codex is included with ChatGPT plans and that ChatGPT and API billing are
separate:

- [Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-chatgpt)
- [ChatGPT and API billing are separate](https://help.openai.com/en/articles/8156019-is-api-usage-included-in-chatgpt-subscriptions-even-if-i-have-a-paid-chatgpt-account)

## Production data path

```text
Codex / Pi
    |
    | x-ai-router-token
    v
Cloudflare Worker
    |
    +-- acquire + encrypted credential --> SQLite Durable Object
    |
    +-- one opaque request -------------> Cloudflare AI Gateway
                                              |
                                              | metadata log only
                                              v
                                      custom provider
                                              |
                                              v
                                      Cloudflare Tunnel
                                              |
                                              v
                                      Bun egress relay
                                              |
                                              v
                               chatgpt.com/backend-api/codex/responses
```

Cloudflare’s direct AI Gateway egress to `chatgpt.com` was rejected by the upstream edge during
deployment testing. The relay therefore provides a stable non-Worker egress point. It accepts only
the Codex Responses and usage paths, authenticates the gateway-to-relay hop with a distinct
transport token, strips Cloudflare and forwarding headers, and never selects accounts.

AI Gateway was also observed adding `nonce` fields to JSON SSE events. The relay labels SSE as
`application/octet-stream` across that hop and the Worker restores `text/event-stream` from a
controlled response header. The model body remains unread and byte-exact.

See [architecture](docs/architecture.md), [operations](docs/operations.md),
[canary evidence](docs/canary.md), and [security](docs/security.md).

## Routes

Authenticated model `POST` routes:

- `/responses`
- `/v1/responses`
- `/codex/responses`
- `/responses/compact`
- `/v1/responses/compact`

Operational routes:

- `GET /healthz` — unauthenticated liveness only;
- `GET /status` — client-authenticated sanitized routing state;
- `GET /admin/accounts` — admin-authenticated account summaries;
- `PUT /admin/accounts/:accountId/credential` — import/replace one subscription credential;
- `POST /admin/accounts/:accountId/enabled` — enable or disable an account;
- `DELETE /admin/accounts/:accountId` — remove an account;
- `GET /admin/key-versions` — encrypted-record counts by key version;
- `GET /admin/canary/sse` — admin-authenticated deployed streaming canary.

Use `x-ai-router-token` or bearer authorization for model traffic. Admin routes require the distinct
`x-ai-router-admin-token`. Explicit supported session headers drive affinity; the router never
derives a session from IP addresses, user agents, credentials, or prompt content.

HTTP/SSE is the compatibility contract. WebSocket routing is not advertised.

## Install and verify

Requirements:

- Bun;
- `kubectl` for the relay manifest test;
- Wrangler for the Worker build/deploy commands.

```bash
bun install --frozen-lockfile
bun run check
```

The gate checks formatting, lint, types, all tests, and a Wrangler deployment dry run.

## Run on Bun

Required:

- `CODEX_ROUTER_CLIENT_TOKEN`
- `CODEX_ROUTER_ADMIN_TOKEN`

Optional:

- `CODEX_ROUTER_ACCOUNTS_JSON` — bootstrap-only subscription credentials and usage; defaults to
  `[]`;
- `CODEX_ROUTER_DATABASE_PATH` — defaults to `./data/codex-router.sqlite`;
- `HOST` — defaults to `0.0.0.0`;
- `PORT` — defaults to `8787`.

The client and admin tokens must differ. Start the server:

```bash
bun run start:bun
```

Native SQLite supports one writer process per database file. Do not mount one ordinary SQLite PVC
read-write from multiple Kubernetes replicas.

Account administration uses the same client against Bun or Workers:

```bash
export CODEX_ROUTER_ADMIN_URL=https://router.example
export CODEX_ROUTER_ADMIN_TOKEN=stored-outside-shell-history

bun run admin:bun list
bun run admin:bun login primary
bun run admin:bun disable primary
bun run admin:bun enable primary
bun run admin:bun remove primary
```

`login` runs OpenAI’s device authorization flow locally and sends the resulting credential only to
the authenticated router admin endpoint.

## Run on Cloudflare

The Worker requires:

- `CODEX_ROUTER_CLIENT_TOKEN`
- `CODEX_ROUTER_ADMIN_TOKEN`
- `CODEX_ROUTER_RELAY_TOKEN`
- `CODEX_ROUTER_CREDENTIAL_KEYS_JSON`
- `CF_AIG_ACCOUNT_ID`
- `CF_AIG_GATEWAY_ID`
- `CF_AIG_CUSTOM_PROVIDER_SLUG`
- `CF_AIG_TOKEN`

`CODEX_ROUTER_ACCOUNTS_JSON` is optional bootstrap input. Routine account lifecycle goes through the
admin API and encrypted Durable Object vault.

`CODEX_ROUTER_CREDENTIAL_KEYS_JSON` has this shape:

```json
{
  "currentVersion": "v2",
  "keys": {
    "v1": "base64url-encoded-32-byte-key",
    "v2": "base64url-encoded-32-byte-key"
  }
}
```

Every client/admin/relay token must be distinct. Enter secrets through Wrangler stdin or another
secret channel; do not commit them or place values in command history.

The AI Gateway custom provider must point at the authenticated tunnel relay, not directly at
`chatgpt.com`. Keep static provider headers empty. The Worker supplies the relay token per request
and forces payload logging off, cache bypass, and one attempt.

```bash
bun run deploy:worker
```

Relay manifests live under `deploy/kubernetes/relay`. The committed resources intentionally exclude
Secret, Registry Secret, Service, and Ingress objects; the deployment consumes externally managed
`codex-router-egress` and `codex-router-ghcr` secrets and uses a remotely configured Cloudflare
Tunnel sidecar.

## Packages

- `@akua-dev/codex-router-core` — quota policy, state models, selection, classifications;
- `@akua-dev/codex-router-codex` — OAuth, usage, account lifecycle, protocol, opaque handler;
- `@akua-dev/codex-router-bun` — native SQLite, scheduled maintenance, Bun server/admin client;
- `@akua-dev/codex-router-cloudflare` — Durable Object, vault, Worker, AI Gateway adapters;
- `@akua-dev/codex-router-relay` — authenticated fixed-route Bun egress relay;
- `apps/server`, `apps/worker`, `apps/relay` — runtime composition roots.

The official Effect agent skill is vendored at `.agents/skills/effect-ts`; the matching source
checkout is pinned at `.repos/effect`. Read [AGENTS.md](AGENTS.md) before changing the repository.

## Capacity summary

The reconstructed lower bound is 586,932 completed calls, with a recent average of 11,670/day and an
observed peak of 24,657/day, 117/minute, and 9/second.

Request volume fits the 100,000/day Workers Free request allowance. A normal completed model stream
uses three Durable Object requests, so the observed peak projects to 73,971/day before renewals and
the minute cron. However, deployed telemetry observed Worker CPU above the Free plan’s 10 ms
per-invocation allowance. Treat Workers Paid as the safe deployment target unless a newer,
representative CPU canary proves otherwise. Full calculations and missing-data caveats are in
[operations](docs/operations.md).

## License

MIT
