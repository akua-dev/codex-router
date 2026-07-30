# Research and verification

Research date: 2026-07-30.

## Intent understood

The target is not a generic “best AI router.” It is a small Codex load balancer that can:

- choose among quota pools and accounts based on remaining short and weekly allowance;
- preserve session locality;
- run efficiently on Cloudflare Workers;
- use Cloudflare AI Gateway for its dashboard and metadata request logs;
- keep Cloudflare concerns behind adapters so the same domain can run inside AgentOS on Kubernetes;
- avoid buffering, prompt inspection, duplicate sends, and credential leakage.

Cloudflare AI Gateway should remain the final observability hop. Account selection belongs in this
project because AI Gateway has no documented view of ChatGPT subscription quota.

## Corrected product claims

The earlier search answers overstated Cloudflare’s capabilities:

- Cloudflare’s official Codex integration sends Codex Responses traffic to AI Gateway and uses
  Cloudflare Unified Billing. It does not say AI Gateway consumes a ChatGPT subscription.
- A paid ChatGPT plan does not create an OpenAI API key or include ordinary API billing.
- Cloudflare Dynamic Routing and spend limits operate on traffic the gateway knows about; they do
  not expose the remaining Codex quota of multiple ChatGPT logins.
- Therefore, routing multiple subscription accounts by their actual remaining quota needs a custom
  credential and quota adapter. That flow is not a documented OpenAI public API integration and must
  be treated as experimental.

Primary sources:

- [Cloudflare AI Gateway: OpenAI Codex](https://developers.cloudflare.com/ai-gateway/integrations/coding-agents/openai-codex/)
- [Cloudflare Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/)
- [OpenAI: Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-chatgpt)
- [OpenAI: ChatGPT and API billing are separate](https://help.openai.com/en/articles/8156019-is-api-usage-included-in-chatgpt-subscriptions-even-if-i-have-a-paid-chatgpt-account)

## Can an AI router run successfully on Workers?

Yes, with a deliberately small hot path.

Strong evidence:

- Cloudflare describes its internal Hono Worker as authenticating users, stripping credentials,
  injecting an AI Gateway token, proxying provider requests, and passing responses through with zero
  buffering. Cloudflare says changes reach more than 3,000 people through `wrangler deploy`. See
  [Cloudflare’s internal AI engineering stack](https://blog.cloudflare.com/internal-ai-engineering-stack/).
- The open-source Portkey gateway documents Cloudflare Workers as a deployment target, alongside
  local Bun/Node and container deployments. See
  [Portkey deployment documentation](https://github.com/Portkey-AI/gateway/blob/main/docs/installation-deployments.md).
- Community projects such as [Sanitiza.AI](https://github.com/guimaster97/pii-sanitizer-gateway)
  implement OpenAI proxies on Workers. This proves feasibility, not production reliability or
  suitability for opaque Codex streams.

The portable-port architecture is also demonstrated by Portkey’s multiple deployment targets. The
important distinction here is that `codex-router` keeps the policy and protocol packages
runtime-neutral, rather than trying to emulate the Worker runtime in Kubernetes.

## Worker-specific issues learned

| Issue                          | Consequence                                    | Project response                                 |
| ------------------------------ | ---------------------------------------------- | ------------------------------------------------ |
| 10 ms Free CPU                 | Effect/crypto/stream overhead may exceed Free  | opaque body, bounded state, deployed CPU canary  |
| 100,000 Worker requests/day    | account-wide traffic can exhaust Free          | compare daily audit and alert                    |
| 100,000 DO requests/day        | three calls/request leave modest peak headroom | no DO body proxy; renew only after 40 seconds    |
| Miniflare buffering difference | local SSE success may not match production     | deployed incremental/byte-identity canary        |
| partial Node compatibility     | dependencies can bundle but fail at runtime    | Web-standard core; no `nodejs_compat` by default |
| custom-provider URL mapping    | duplicated/missing paths cause 404s            | provider-specific endpoint with root base URL    |
| AI Gateway defaults            | retries/cache/payload logs break transparency  | force one attempt, no cache, metadata-only logs  |
| 100,000 stored logs on Free    | recent average fills storage in about 8.6 days | deletion or Logpush required                     |
| eventually consistent KV       | unsafe lease and assignment races              | SQLite Durable Object transaction                |
| subscription OAuth opacity     | refresh/quota semantics can change unannounced | isolated experimental adapter and release gate   |

Relevant platform documentation:

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [AI Gateway limits](https://developers.cloudflare.com/ai-gateway/reference/limits/)
- [AI Gateway custom providers](https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/)
- [AI Gateway metadata-only logging](https://developers.cloudflare.com/ai-gateway/observability/logging/)
- [Workers Streams](https://developers.cloudflare.com/workers/runtime-apis/streams/)
- [Workers Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
- [Miniflare response-buffering report](https://github.com/cloudflare/workers-sdk/issues/8004)

## Local and AgentOS request audit

The audit inferred completed model calls from rollout JSONL rather than equating files, messages, or
token events with requests:

1. scan 8,028 local Codex rollout files dated February 2 through July 30;
2. identify terminal completion/token records;
3. deduplicate histories copied by resume/fork flows;
4. scan live rollout homes in the AgentOS Kubernetes pods that ran Codex or Pi;
5. scan the local OrbStack AgentOS homes;
6. compare rollout filenames between local and remote sets to detect obvious overlap;
7. aggregate complete UTC days, minutes, and seconds;
8. record unmounted PVCs as missing data rather than estimating their contents.

Results:

| Evidence                                               | Count or observation |
| ------------------------------------------------------ | -------------------: |
| Local rollout files                                    |                8,028 |
| Raw local completion/token records                     |            1,993,486 |
| Deduplicated inferred local completed calls            |              570,364 |
| Remote live AgentOS calls, July 21–30                  |              ~15,219 |
| Local OrbStack AgentOS calls                           |                1,349 |
| Known combined lower bound                             |             ~586,932 |
| Last nine complete UTC days                            |              105,034 |
| Recent daily average                                   |               11,670 |
| Observed peak day                                      |               24,657 |
| Observed peak minute                                   |                  117 |
| Observed peak second                                   |                    9 |
| Remote-cluster peak day                                |               ~3,249 |
| Accounts in inspected AgentOS gateway                  |                    2 |
| Sticky assignments in inspected AgentOS gateway        |                   69 |
| Scaled-to-zero StatefulSets with unmounted 20 GiB PVCs |                   20 |

No matching rollout filenames were found between the local and remote audited sets.

This is a lower bound, not provider billing truth. Terminal records can be absent after crashes, and
the 20 PVCs were not mounted. Conversely, the deduplication step is inferential, so repeat the
method against provider-side metadata after deployment.

## Free-tier estimate

At the observed peak day:

```text
Worker: 24,657 / 100,000 = 24.657%
Durable Object normal path: 24,657 × 3 = 73,971 / 100,000 = 73.971%
AI Gateway peak ingress: 9 / 500 = 1.8%
AI Gateway stored-log horizon: 100,000 / 11,670 ≈ 8.6 days
```

Worker request volume fits. Normal Durable Object traffic fits with about 26% request headroom. Long
streams add renewals, and the missing PVCs make the estimate incomplete. Worker CPU cannot be
inferred from request counts or bundle size; the 10 ms Free limit is a deployment measurement.

## Router alternatives

| Choice                                           | Strength                                                      | Mismatch for this intent                                   |
| ------------------------------------------------ | ------------------------------------------------------------- | ---------------------------------------------------------- |
| `codex-router`                                   | Worker/Bun portability, explicit quota policy, opaque SSE     | live quota/OAuth refresh still incomplete                  |
| [codex-lb](https://github.com/Soju06/codex-lb)   | mature dashboard, account pooling, SQLite/Postgres, WebSocket | larger Python/UI system; not a Worker-native Effect core   |
| [Portkey](https://github.com/Portkey-ai/gateway) | broad multi-provider gateway and Worker deployment            | generic model gateway, not AgentOS quota semantics         |
| Cloudflare AI Gateway alone                      | excellent logging, analytics, auth, gateway controls          | no ChatGPT subscription quota or sticky account state      |
| LiteLLM or another general proxy                 | many providers, fallback, budgets                             | provider/API budget routing differs from Codex quota pools |

`codex-lb` is the closest functional comparison and is likely the faster choice when its larger
self-hosted service and dashboard are desired. This project is justified when the constraints are
Worker efficiency, Effect-based portable policy, AgentOS reuse, and Cloudflare AI Gateway
observability.

## OpenTelemetry verification

The pasted research on observability was directionally useful but too absolute.

The OpenTelemetry project still describes its Collector as vendor-agnostic, multi-signal,
extensible, and generally recommended alongside services for batching, retries, encryption, and
filtering. It also labels Collector component stability as mixed. That makes OTel Collector the
sound general default for unified traces, metrics, and logs—not automatically the performance winner
for every specialized log pipeline. See
[OpenTelemetry Collector](https://opentelemetry.io/docs/collector/).

VictoriaMetrics’ March 2026 benchmark reports 143,000 logs/second for `vlagent` versus 31,300 for
Fluent Bit, 25,000 for Vector, and 20,500 for OTel Collector under its 100-Pod, one-CPU, 1 GiB,
default-chart test. The benchmark publishes its harness, but it is vendor-authored and
workload-specific. The same article says `vlagent` lacks multiline joining and custom-format
parsing. It does not justify calling `vlagent` the universal performance leader. See
[VictoriaMetrics’ benchmark](https://victoriametrics.com/blog/log-collectors-benchmark-2026/).

Practical conclusion:

- use OTel Collector when multi-signal interoperability, trace processing, and vendor neutrality
  dominate;
- evaluate Fluent Bit or Vector for mature/highly programmable edge log collection;
- evaluate `vlagent` for a VictoriaLogs-oriented, structured Kubernetes log workload;
- reproduce the exact workload before replacing a collector;
- keep telemetry collection separate from this request router.

## AgentOS and Pi findings

The local AgentOS implementation supplied the policy used here:

- 60-second quota freshness and 24-hour maximum age;
- 10% short and 3% weekly minimum remaining;
- five-point stale penalty;
- quota-expiry urgency scoring;
- seven-day session assignment and 10% hysteresis;
- 120-second lease and 40-second stream renewal;
- authentication before body access;
- atomic refresh locks, credential generations, and provider-identity verification;
- transparent response streaming and bookkeeping that never replaces the upstream response.

The Pi remote-compaction extension added:

- 120-second default and 600-second maximum timeout;
- 16 MiB maximum response;
- a terminal completion requirement;
- exactly one canonical compaction artifact;
- explicit session and prompt-cache identifiers;
- opaque preservation of response items;
- local summary fallback.

The current project carries the routing and forwarding rules. The live quota/credential refresh and
Pi compaction response constraints remain work for later tested slices.
