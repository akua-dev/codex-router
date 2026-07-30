# Security

## Posture

The router is a privileged ChatGPT subscription credential multiplexer. Its security invariants are:

1. authenticate before touching a model body;
2. keep client, admin, relay, gateway, tunnel, and upstream credentials separate;
3. expose no upstream credential or provider identity;
4. send each model request once;
5. persist no model payload;
6. bind every response/refresh/usage mutation to the credential generation that produced it;
7. fail closed when configuration, state, identity, or decryption is invalid.

These controls do not decide whether multi-account ChatGPT OAuth pooling is permitted. Terms,
privacy, account ownership, and organization-policy review remain an independent requirement.

## Assets

- router client token;
- router admin/internal token;
- relay transport token;
- subscription access and refresh tokens;
- provider account identity embedded in subscription credentials;
- AI Gateway Run token;
- Cloudflare Tunnel token;
- AES-GCM credential-encryption keyring;
- Kubernetes registry pull credential;
- account usage, health, generation, refresh-claim, assignment, and lease state;
- prompts, tool inputs, model output, reasoning, and compaction artifacts in transit.

Opaque router account IDs are operational metadata. They should not be joined to human identity in
routine logs.

## Trust boundaries

```text
caller -- public network + router token --> Worker/Bun ingress
operator -- separate admin token --------> account administration
Worker -- internal token + small RPC ----> Durable Object
Worker -- run token + relay token -------> AI Gateway
AI Gateway -- relay token + Tunnel ------> Bun relay
relay -- selected subscription secret ---> chatgpt.com
operator/automation -- secret channel ---> runtime bindings and Kubernetes Secrets
```

Cloudflare AI Gateway and the upstream provider necessarily observe the traffic they forward. The
Durable Object, routing SQLite tables, application logs, and Git repository must not.

## Ingress controls

- Model callers use `x-ai-router-token` or bearer authorization.
- Admin callers use only `x-ai-router-admin-token`.
- Client/admin/relay tokens must be pairwise distinct.
- Bun, Workers, and the relay compare fixed-length SHA-256 digests through Effect `Crypto`, using
  constant-time accumulation after hashing.
- Authentication happens before model request-body access.
- Method and route validation happens before account acquisition.
- Explicit session values must be non-empty and at most 256 characters.
- `/healthz` exposes liveness only.
- `/status` requires client authentication and returns sanitized counts/state.
- Admin inputs have a 16 KiB content-length bound and Schema decoding.
- Imported access tokens are decoded enough to derive provider identity; caller-supplied provider
  identity is not trusted.

The current Cloudflare Access applications use bypass policies so the Codex client and custom
provider can reach their domains. Application-layer authentication is therefore mandatory, not
defense in depth.

## Model forwarding controls

Before upstream transmission, the router removes:

- caller authorization and API-key variants;
- provider-account identity;
- router auth and session-routing headers;
- host and content length;
- Cloudflare/forwarding headers at the relay;
- hop-by-hop headers.

It injects only the selected subscription authorization and matching provider account identity. It
does not clone, buffer, log, hash, parse, or retry the model body.

The relay accepts only fixed Codex usage/Responses paths. Its `x-api-key` is a dedicated internal
transport credential. The relay strips it before reaching `chatgpt.com`; it is not an OpenAI API
credential.

The response wrapper removes headers invalidated by runtime decoding/reframing and otherwise
preserves status, status text, safe headers, order, and bytes. No fallback/retry follows the single
transport call.

## Generation safety

Credential generation is part of every security-sensitive state transition:

- refresh claims carry the expected generation;
- replacement credentials must advance by exactly one generation;
- replacement provider identity must match;
- usage claims and commits carry the generating credential version;
- 401 reauthentication marks only the still-current rejected generation;
- late failures from an older stream cannot invalidate a newer login/refresh;
- replacing or removing an account clears incompatible claims and state.

Claims expire after 30 seconds. Lease expiry and assignment cleanup are performed in atomic state
operations.

## Credential storage

### Cloudflare

Subscription credentials cross the Worker-to-Durable-Object boundary only inside an AES-256-GCM
envelope:

- 32-byte key;
- independent random 96-bit nonce;
- explicit immutable key version;
- opaque account ID as additional authenticated data;
- credential generation authenticated inside the encrypted model;
- Schema decoding after authenticated decryption.

The Durable Object stores key version, nonce, and ciphertext. The Worker decrypts only the selected
credential. A wrong key/version/nonce/ciphertext/account ID fails closed.

The multi-version keyring supports online rotation. Decrypting an old-version record rewrites it
with a fresh nonce under the current key. `GET /admin/key-versions` exposes only ciphertext counts,
not key material.

### Bun

The Bun SQLite adapter persists subscription access and refresh tokens in its account rows so OAuth
refresh survives restart. Unlike the Cloudflare vault, that payload is not application-level
encrypted.

Required compensating controls:

- encrypted node/PVC storage;
- namespace and filesystem access restricted to the router process;
- encrypted, access-controlled backups;
- no shared multi-writer PVC;
- no database copy in bug reports or build artifacts;
- an external secret/vault adapter before deployment into an environment that requires
  application-level envelope encryption.

Bootstrap account JSON also contains credentials. Prefer authenticated device login after initial
deployment and remove bootstrap values when operationally possible.

## AI Gateway privacy and transparency

Every model and usage call through AI Gateway sets:

- `cf-aig-collect-log-payload: false`;
- `cf-aig-skip-cache: true`;
- `cf-aig-max-attempts: 1`;
- `cf-aig-authorization` from the Worker secret;
- at most five bounded, non-sensitive metadata values.

The deployed canaries confirmed stored request, response, and prompt lengths are all zero.

Request and response DLP are disabled. Response DLP would buffer the stream; request DLP conflicts
with the no-inspection boundary. AI Gateway Dynamic Routing and `/compat` do not participate in
subscription account selection.

AI Gateway was observed mutating JSON SSE by inserting `nonce` values. Carrying SSE as opaque binary
through the gateway and restoring only the content type at the Worker prevents that mutation without
reading the body. Do not remove this encapsulation while the behavior remains.

Gateway logs are configured to delete oldest entries at the storage limit. Metadata retention is
short and is not an audit archive.

## Prohibited data sinks

Never put credentials or model content in:

- routing or account summaries;
- Durable Object routing RPC payloads outside encrypted credential envelopes;
- assignment, reservation, block, or usage metadata;
- Worker, Bun, relay, tunnel, or Kubernetes logs;
- AI Gateway custom metadata;
- tracing names/attributes or metrics labels;
- URLs, query strings, error messages, crash reports, test snapshots, or tickets.

Never log full request/response headers. Sensitive names include `authorization`, `api-key`,
`x-api-key`, `x-ai-router-token`, `x-ai-router-admin-token`, `chatgpt-account-id`, cookies,
Cloudflare authorization, refresh material, and forwarded identity.

Do not run a full-header live tail during account import, quota probes, or model canaries.

## Rotation

### Credential-encryption keyring

1. generate a new random 32-byte key with a new version;
2. retain old and new versions in the keyring;
3. make the new version current and deploy;
4. exercise every enabled account through maintenance/traffic;
5. explicitly handle disabled accounts;
6. verify old-version count is zero through the admin endpoint;
7. retain the old key for the approved rollback window;
8. retire it and redeploy.

Never reuse a version with different bytes or remove a key with nonzero ciphertext count.

### Other credentials

Rotate independently:

- client token;
- admin/internal token;
- relay token in Worker and Kubernetes Secret;
- AI Gateway Run token;
- Tunnel token;
- registry pull token;
- subscription credentials through device login or refresh.

The client/admin ingress currently has no two-token overlap window. Coordinate consumers and deploy
atomically enough for the accepted interruption. Relay rotation requires both ends to overlap or a
brief controlled outage.

## Kubernetes relay hardening

The committed deployment:

- runs both containers as non-root UID/GID 1000;
- disables service-account token automount;
- uses read-only root filesystems;
- drops all capabilities and forbids privilege escalation;
- pins image digests;
- sets resource requests/limits;
- denies all ingress;
- permits only DNS plus TCP 443/7844 egress.

The tunnel terminates at loopback in the same Pod, so a Kubernetes Service is unnecessary. Keep the
relay package private unless distribution requirements change. Prefer a narrowly scoped,
read-package-only GHCR credential and rotate any broad bootstrap credential used during setup.

## Residual risks and limitations

- The provider’s private subscription endpoints and response shapes can change without public API
  stability guarantees.
- OpenAI may restrict account pooling independently of technical correctness.
- Bun credential rows lack application-level encryption.
- Client/admin token rotation lacks a dual-generation overlap mode.
- AI Gateway metadata retention is delete-oldest rather than durable audit export.
- No WebSocket support or deployed WebSocket canary exists.
- No multi-region or multi-writer Bun state adapter exists.
- Cloudflare analytics is aggregated and can be sampled; it is not a per-request security ledger.
- The fixed relay adds a Kubernetes/tunnel dependency and its own availability surface.

These are explicit operating constraints, not reasons to add API-key mode or body inspection.

## Incident response

If a credential or router token may be exposed:

1. stop or restrict new traffic at the relevant ingress;
2. revoke/rotate the affected subscription, gateway, relay, tunnel, registry, or router credential;
3. retain every old AES key needed to read unaffected ciphertext during recovery;
4. replace runtime bindings through secret channels;
5. inspect only sanitized metadata, generation, status, and rate evidence;
6. never copy payloads or full headers into incident tooling;
7. remove incompatible assignments/health if account ownership changed;
8. redeploy and run authentication, live usage, exact-byte SSE, privacy, and one-send checks;
9. document scope, exposure window, affected generations, and prevention work.

If payload logging or cache was accidentally enabled, treat stored/cached model content as exposure,
delete/purge it through Cloudflare controls, and involve the data owner.
