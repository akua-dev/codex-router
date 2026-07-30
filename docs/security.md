# Security

## Security posture

The router is a privileged credential multiplexer. Its most important properties are:

1. authenticate the caller before accessing the body;
2. expose no upstream credential or provider identity;
3. transmit a model request once;
4. persist no model payload;
5. keep account selection and credential lookup separate;
6. fail closed when configuration or routing state is invalid.

The current subscription adapter is experimental. Security controls do not make an unsupported
provider workflow supported; an explicit OpenAI terms, privacy, and organization-policy review is a
separate release gate.

## Assets

- router client token;
- OpenAI API keys or experimental subscription access credentials;
- provider account identity associated with a subscription credential;
- Cloudflare AI Gateway Run token;
- AES-GCM credential-encryption key;
- session-to-account assignments;
- account usage and health state;
- user prompts, tool inputs, model output, and compaction artifacts in transit.

Opaque router account IDs are operational metadata, not credentials, but they should not be joinable
to human identities in ordinary logs.

## Trust boundaries

```text
caller -- untrusted network --> Worker/Bun ingress
router -- selected secret ---> AI Gateway or upstream provider
Worker -- small internal RPC -> Durable Object
operator -- secret channel --> runtime bindings
```

Cloudflare AI Gateway and the upstream provider can observe traffic they forward. The application
database and Durable Object cannot.

## Implemented controls

### Ingress

- The caller supplies either a dedicated router-token header or bearer authorization.
- Bun compares equal-length tokens with `timingSafeEqual`.
- Workers compare SHA-256 digests with a constant-time accumulation.
- Authentication happens before request-body access.
- Unsupported methods and paths are rejected.
- Explicit session values are non-empty and at most 256 characters.
- `/status` requires the same authentication and returns only sanitized counts.
- `/healthz` reports liveness only and reveals no account state.

### Request forwarding

Caller-supplied provider credentials, proxy credentials, provider account identity, router auth,
session routing headers, host, content length, and hop-by-hop headers are removed. Only the selected
credential is added. The request body is not cloned, buffered, logged, hashed, parsed, or retried.

### Response forwarding

The router preserves status, status text, safe headers, order, and byte chunks. Headers that become
invalid when a runtime decodes or reframes a stream are removed. No retry is attempted after the
single transport call, whether or not response bytes have started.

### Credential storage

The Bun runtime keeps bootstrap credentials in process memory and secret configuration. Its SQLite
database contains routing state, not credentials.

The Cloudflare runtime writes credential bundles to the Durable Object only as AES-256-GCM
ciphertext:

- 256-bit key decoded from base64url;
- independent 96-bit random nonce;
- explicit key version;
- opaque account ID as additional authenticated data;
- authenticated decryption before Schema decoding.

A wrong key, nonce, key version, ciphertext, or account ID fails decryption. The unencrypted bundle
is returned only to the Worker instance that requested the selected account.

### AI Gateway privacy

Every transport call sends:

- `cf-aig-collect-log-payload: false`;
- `cf-aig-skip-cache: true`;
- `cf-aig-max-attempts: 1`;
- `cf-aig-authorization` from the Worker secret.

Cloudflare states that payload suppression keeps metadata logs but skips raw request and response
bodies; see
[AI Gateway logging](https://developers.cloudflare.com/ai-gateway/observability/logging/). After
deployment, verify the dashboard because gateway-level configuration can change independently of
this repository.

Metadata is bounded to five entries, small encoded size, and short keys. It must not include session
identifiers, prompt-derived values, upstream credentials, provider identity, human identity, or full
URLs.

## Prohibited data sinks

Never put model content or credentials in:

- Durable Object routing RPCs;
- SQLite routing tables;
- Worker logs, Bun logs, errors, or status responses;
- AI Gateway custom metadata;
- tracing span names or attributes;
- metrics labels;
- URLs or query strings;
- crash reports or test snapshots.

Never log full request or response headers. In particular, authorization, API-key variants,
provider-account identity, cookies, and refresh material are sensitive.

## Key rotation

For the Worker vault:

1. create a new random 256-bit key under a new key version;
2. make the application capable of decrypting the old and new versions;
3. make the new version current for writes;
4. re-encrypt every bundle with a fresh nonce and the same account-ID AAD;
5. read and verify every rewritten bundle;
6. retire the old version only after verification and rollback-window approval.

The current bootstrap exposes one configured key version. A multi-version rotation workflow must
land before unattended production rotation; replacing the only key makes existing ciphertext
unreadable.

Router client tokens and AI Gateway Run tokens should be rotated independently. During a controlled
overlap, accept both client-token generations at the ingress adapter, remove the old generation
after clients migrate, and verify rejected traffic. This overlap is not implemented in the current
single-token configuration.

## Known gaps

- No automated acquisition or refresh of subscription OAuth credentials.
- No generation-safe protection against an old in-flight 401 invalidating a newly rotated token.
- No live quota refresh; stale bootstrap data can cause availability loss or poor selection.
- No deployed Worker CPU/SSE canary.
- No external secret-manager adapter for the Bun runtime.
- No audit-log export or automated AI Gateway log-retention policy.
- No WebSocket protocol support or validation.
- No multi-region/multi-replica Bun state implementation.

Until these gaps are closed, use only controlled development traffic and manually maintained
credentials.

## Incident response

If a credential or router token may be exposed:

1. remove public traffic or require an unaffected ingress token;
2. revoke the suspected upstream and AI Gateway credentials at their issuers;
3. rotate the vault key if ciphertext or the key may have leaked;
4. replace runtime bindings through the secret channel;
5. inspect only metadata logs for unexpected account IDs, statuses, rates, and source controls;
6. do not copy payloads or secret headers into an incident ticket;
7. invalidate assignments and health state if account ownership changed;
8. deploy and run authentication, byte-stream, and privacy canaries;
9. document scope, exposure window, affected generations, and prevention work.

If AI Gateway payload logging was accidentally enabled, follow the configured deletion/export
controls immediately and involve the data owner. Treat cached model responses as payload exposure
and purge them.
