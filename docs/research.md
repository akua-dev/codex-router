# Research and verification

Research and deployment verification date: 2026-07-30.

## Intent

The target is not a generic “best AI router.” It is a compact Codex load balancer that:

- distributes ChatGPT subscription traffic using live remaining quota;
- protects prompt-cache/session locality;
- runs efficiently at the Cloudflare edge;
- retains Cloudflare AI Gateway’s useful metadata dashboard;
- can reuse the same Effect policy inside AgentOS on Kubernetes;
- never adds OpenAI API-key mode, prompt inspection, buffering, replay, or credential leakage.

Cloudflare AI Gateway remains the final observability hop. It cannot see the subscription quota
stored behind different ChatGPT OAuth credentials, so account selection belongs in this project.

## Corrected product claims

The earlier search answers overstated Cloudflare’s subscription support:

- Cloudflare’s official Codex integration documents its OpenAI-compatible gateway and Unified
  Billing. It does not say AI Gateway consumes a ChatGPT subscription.
- A paid ChatGPT plan does not create an OpenAI API key and does not include ordinary API billing.
- Dynamic Routing, spend limits, and provider fallback operate on gateway-visible request/provider
  data; they do not expose each ChatGPT login’s remaining Codex windows.
- Cloudflare cannot natively pool multiple Codex subscriptions by their actual quota.
- A custom router must own OAuth credential lifecycle, provider identity, live quota, sticky
  assignment, and generation-safe health.

Primary sources:

- [Cloudflare AI Gateway: OpenAI Codex](https://developers.cloudflare.com/ai-gateway/integrations/coding-agents/openai-codex/)
- [Cloudflare Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/)
- [Cloudflare Dynamic Routing](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/)
- [OpenAI: Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-chatgpt)
- [OpenAI: ChatGPT and API billing are separate](https://help.openai.com/en/articles/8156019-is-api-usage-included-in-chatgpt-subscriptions-even-if-i-have-a-paid-chatgpt-account)

Multi-account ChatGPT OAuth pooling is not documented as an OpenAI public API product. This project
therefore treats subscription routing as experimental and requires an account-owner policy review.

## Do AI routers work on Workers?

Yes. The evidence supports a small, Web-standard streaming gateway:

- Cloudflare describes an internal Hono Worker that authenticates users, strips credentials, injects
  an AI Gateway token, proxies provider requests, and returns responses with no buffering. See
  [Cloudflare’s internal AI engineering stack](https://blog.cloudflare.com/internal-ai-engineering-stack/).
- Portkey’s open-source gateway documents Cloudflare Workers alongside local and container
  deployments. See
  [Portkey deployment documentation](https://github.com/Portkey-AI/gateway/blob/main/docs/installation-deployments.md).
- Community projects such as [Sanitiza.AI](https://github.com/guimaster97/pii-sanitizer-gateway) run
  OpenAI-style gateway logic on Workers.
- This repository’s deployed synthetic and real subscription canaries now prove its own
  Worker/AI-Gateway/Tunnel/Bun-relay composition.

Those examples prove feasibility, not transparent behavior for every provider protocol. Codex SSE,
OAuth pooling, Durable Object coordination, and Free-tier CPU still need their own evidence.

## Issues learned online and in deployment

| Issue                                              | Consequence                                                            | Project response                                                       |
| -------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Workers Free allows 10 ms CPU/invocation           | Effect/crypto/stream work can exceed Free even when request count fits | collect deployed GraphQL CPU; recommend Paid from current trace        |
| 100,000 Worker requests/day                        | account-wide traffic can exhaust Free                                  | reconstruct local/AgentOS volume and include cron                      |
| 100,000 DO requests/day                            | acquire/record/release leaves limited renewal headroom                 | no body through DO; renew at most every 40 seconds                     |
| Miniflare compressed-response buffering difference | local SSE success does not prove edge streaming                        | exact-byte deployed fixture with first-byte timing                     |
| partial Node compatibility                         | packages can bundle yet fail at runtime                                | Web APIs in portable/Worker code; no `nodejs_compat` dependency        |
| custom-provider path prefixing                     | duplicate or missing `/v1` paths return 404                            | relay explicitly accepts tested canonical and `/v1` forms              |
| direct gateway egress to `chatgpt.com` rejected    | custom provider could not reach subscription backend from edge         | authenticated Tunnel to a fixed-route Bun egress relay                 |
| AI Gateway inserted nonce fields in JSON SSE       | downstream bytes changed despite payload logging off                   | carry body as octet-stream, restore content type at Worker             |
| gateway retries/cache/payload defaults             | replay or data retention can violate invariants                        | force one attempt, cache skip, payload collection false per call       |
| 100,000 stored logs                                | dashboard history lasts days at audited volume                         | delete oldest; use payload-free Logpush only if longer history needed  |
| eventually consistent KV                           | unsafe refresh/lease/assignment races                                  | SQLite Durable Object transaction                                      |
| private subscription response shapes               | null/weekly-only fields can break strict decoders                      | decode known shapes, reject unknown window durations                   |
| request-scoped Worker bindings                     | global runtime can retain a stale DO stub/environment                  | create and dispose one ManagedRuntime per non-health request           |
| no dedicated Effect Cloudflare runtime package     | assuming Node/Bun adapters would undermine edge portability            | generic Effect Web router/bridge, BrowserCrypto, and SQLite-DO adapter |

References:

- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Workers Streams](https://developers.cloudflare.com/workers/runtime-apis/streams/)
- [Workers Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Durable Object metrics](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/)
- [AI Gateway limits](https://developers.cloudflare.com/ai-gateway/reference/limits/)
- [AI Gateway custom providers](https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/)
- [AI Gateway logging](https://developers.cloudflare.com/ai-gateway/observability/logging/)
- [Miniflare response-buffering issue](https://github.com/cloudflare/workers-sdk/issues/8004)

The direct-egress rejection and SSE nonce mutation are deployment observations, not documented
Cloudflare guarantees. Keep the canaries because either behavior can change.

## Local and AgentOS request audit

The audit inferred completed model calls rather than equating rollout files, user messages, or token
events with requests:

1. scan 8,028 local Codex rollout files from February 2 through July 30;
2. identify terminal completion/token records;
3. deduplicate histories copied by resume/fork;
4. inspect live AgentOS Kubernetes homes that ran Codex or Pi;
5. inspect local OrbStack AgentOS homes;
6. compare rollout filenames between local and remote sets;
7. aggregate complete UTC days, minutes, and seconds;
8. record unmounted PVCs as missing instead of fabricating counts.

Results:

| Evidence                                               | Count or observation |
| ------------------------------------------------------ | -------------------: |
| Local rollout files                                    |                8,028 |
| Raw local completion/token records                     |            1,993,486 |
| Deduplicated inferred local calls                      |              570,364 |
| Remote live AgentOS calls, July 21–30                  |              ~15,219 |
| Local OrbStack AgentOS calls                           |                1,349 |
| Known combined lower bound                             |             ~586,932 |
| Last nine complete UTC days                            |              105,034 |
| Recent average                                         |           11,670/day |
| Observed peak day                                      |               24,657 |
| Observed peak minute                                   |                  117 |
| Observed peak second                                   |                    9 |
| Remote-cluster peak day                                |               ~3,249 |
| Accounts in inspected AgentOS gateway                  |                    2 |
| Sticky assignments in inspected gateway                |                   69 |
| Scaled-to-zero StatefulSets with unmounted 20 GiB PVCs |                   20 |

No matching rollout filenames were found between the audited local and remote sets.

This is a lower bound, not provider billing truth. Crashes can omit terminal records, the 20 PVCs
were not mounted, and deduplication is inferential.

## Cloudflare capacity conclusion

At the observed peak, including the minute cron:

```text
Worker: 24,657 + 1,440 = 26,097 / 100,000 = 26.097%
DO baseline: 24,657 × 3 + 1,440 = 75,411 / 100,000 = 75.411%
AI Gateway peak ingress: 9 / 500 = 1.8%
```

Long streams add DO renewals. Status, admin, failed acquisition, and uncounted PVC traffic consume
more headroom.

AI Gateway log retention at the recent average is approximately:

```text
100,000 / (11,670 model calls + 1,440 usage probes per enabled account)
one account: about 7.6 days
two accounts: about 6.9 days
```

Request volume fits the Free limits. CPU does not: the final post-deploy smoke averaged 12.688 ms
over four successful Worker invocations, while the fuller real-canary window averaged 20.80 ms over
nine and reached a 46.481 ms minute p99. The Free allowance is 10 ms/invocation. These mixed
diagnostic windows are not throughput benchmarks, but they are enough to reject an unconditional
Free-tier claim.

See [operations](operations.md) and [canary evidence](canary.md).

## Alternatives

| Choice                                           | Strength                                                                     | Mismatch for this intent                                  |
| ------------------------------------------------ | ---------------------------------------------------------------------------- | --------------------------------------------------------- |
| `codex-router`                                   | subscription quota, Effect portability, Worker/DO, opaque SSE, AgentOS reuse | private provider contract; requires tunnel relay          |
| [codex-lb](https://github.com/Soju06/codex-lb)   | established account pooling, UI, SQLite/Postgres, WebSocket features         | larger Python/UI system; not a Worker-native Effect core  |
| [Portkey](https://github.com/Portkey-AI/gateway) | broad provider gateway and Worker deployment                                 | generic model/API routing rather than ChatGPT quota pools |
| Cloudflare AI Gateway alone                      | excellent logs, analytics, auth, gateway controls                            | no subscription OAuth quota or sticky account state       |
| LiteLLM/general proxies                          | many providers, fallback, budgets                                            | API/provider budget routing is a different problem        |

`codex-lb` remains the closest functional comparator. It is the faster choice when its larger
self-hosted service and UI are preferred. This project is justified by Effect-based policy reuse,
Worker coordination, AgentOS compatibility, and explicit streaming/privacy constraints.

## OpenTelemetry verification

The pasted observability research was directionally useful but too absolute.

OpenTelemetry still describes its Collector as vendor-agnostic, multi-signal, and extensible, and
recommends a collector alongside services for batching, retries, encryption, and filtering. Its
component maturity is mixed. It remains the sound general default for unified traces, metrics, and
logs, not the automatic throughput winner for every log workload. See
[OpenTelemetry Collector](https://opentelemetry.io/docs/collector/).

VictoriaMetrics’ March 2026 vendor benchmark reports 143,000 logs/second for `vlagent` versus 31,300
for Fluent Bit, 25,000 for Vector, and 20,500 for OTel Collector under its particular 100-Pod,
one-CPU, 1 GiB default-chart setup. It publishes a harness and also notes missing multiline and
custom-format capabilities. The result is workload-specific, not a universal ranking. See
[VictoriaMetrics’ benchmark](https://victoriametrics.com/blog/log-collectors-benchmark-2026/).

Practical conclusion:

- choose OTel Collector for multi-signal interoperability and trace processing;
- evaluate Fluent Bit or Vector for mature/programmatic edge log pipelines;
- evaluate `vlagent` for VictoriaLogs-oriented structured Kubernetes logs;
- reproduce the actual workload before switching;
- keep telemetry collection outside this request router.

## AgentOS and Pi findings carried into the project

From `/Users/robin/Developer/cnap-tech/agentos`:

- 60-second quota freshness and 24-hour maximum age;
- 10% short and 3% weekly minimum remaining;
- five-point stale penalty and quota-expiry urgency;
- seven-day sticky assignment and 10% hysteresis;
- 120-second lease with 40-second renewal;
- atomic refresh claims, credential generations, and provider-identity verification;
- authenticate before body access;
- transparent one-send streaming;
- bookkeeping failure never replacing an upstream response;
- 401/429/403/404/5xx account-health classification.

The Pi remote-compaction extension contributed:

- 120-second default and 600-second maximum timeout;
- 16 MiB maximum response;
- terminal completion requirement;
- exactly one canonical compaction artifact;
- explicit session and prompt-cache identifiers;
- opaque response-item preservation;
- local summary fallback.

The router implements the reusable routing, OAuth, quota, generation, and forwarding rules. Pi’s
client-side compaction response-size/artifact validation remains a client concern and is not copied
into the opaque proxy.
