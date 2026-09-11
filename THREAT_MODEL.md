# Threat model

## Scope and assets

The exposed feature is `get_delivery_status`, reading authorized stored status. Webhooks maintain that projection. Internal listing support and a dormant Drive GET client exist, but list/help tools and provider refresh are not exposed.

Assets include DoorDash signing keys/JWTs, webhook credentials/tokens, MCP access tokens and IdP trust configuration, database encryption keys, provider-ID tokens/ciphertext, internal delivery references, tenant/subject/access mappings, merchant/status/ETA data, normalized history, audit evidence, and service/database availability. Delivery status and timing remain sensitive even without addresses.

Assume attackers can submit arbitrary public HTTP requests and obtain an ordinary tenant account. Consider compromised clients, stolen tokens, malicious authenticated webhook senders, compromised IdP/configuration, insiders, database readers/writers, and process compromise. Development auth and local stdio are trusted-machine conveniences, not production security boundaries.

## Trust boundaries

| Boundary | Data and trust decision |
| --- | --- |
| MCP client ↔ server | Bearer access token and opaque reference in; minimized status out. Every HTTP MCP request verifies identity; tool execution checks scope, access join, and tenant. |
| Server ↔ OIDC IdP | PKCE authorization/code exchange and JWT/JWKS verification. Issuer configuration and discovered token/JWKS endpoints are trusted configuration. |
| Server ↔ DoorDash API | Separate service-to-service JWT. No client OAuth forwarding. Client exists but is not connected to runtime reads. |
| DoorDash → webhook ingress | Basic expected-header or webhook OAuth authentication, then bounded JSON validation and normalization. No per-body signature or enforced event-age window. |
| Server ↔ persistence / secrets / logs | Parameterized queries and minimized records cross into durable storage. Current secrets are environment-backed; managed adapter is a stub. Logs and audit records are sensitive. |
| Reverse proxy ↔ server | Deployment must enforce HTTPS, trusted origins/hosts, header policy, and edge rate limits. Incoming request IDs are accepted; proxy trust is not enabled in Fastify. |

## Threat analysis

“Mitigation” describes present code unless explicitly labeled a deployment requirement or future work.

| Threat | Impact | Mitigation | Residual risk / required work |
| --- | --- | --- | --- |
| Stolen or forged MCP token | Unauthorized status disclosure | OIDC signature/JWKS, issuer, audience, expiration and claim-type validation on every HTTP MCP request; internal account lookup | A stolen valid token remains usable until expiry or mapping removal. No introspection/denylist; dev auth has no real login. |
| Scope escalation | Broader tool access | Known-scope filtering and `deliveries:read` check in the registered tool | Trust IdP claim issuance. Internal service methods do not independently check scope. `deliveries:list` metadata does not expose a list tool. |
| Cross-tenant enumeration via references | Discover another tenant's deliveries | Opaque UUIDs, user-access join, explicit tenant equality, generic missing/inaccessible response | UUIDs are not authorization; timing/rate observations remain. Prevent leakage in provisioning and logs. |
| IDOR on delivery lookup | Read a delivery merely by knowing its ID | Tool accepts only an internal reference; non-UUID strings get generic not-found, and access plus tenant are required | Trusted administrators must create correct `delivery_access` links. No database row-level security is configured. |
| Webhook spoofing | False delivery/ETA state | Constant-time Basic-header comparison or signed/expiring webhook OAuth token; known-delivery hash lookup | Shared webhook credentials are not tenant-specific body signatures. Compromise allows forged payloads for known/guessed provider IDs. |
| Webhook replay | Repeat state changes or exhaust resources | Unique deterministic event key and duplicate acknowledgment; OAuth token expiration | `DOORDASH_WEBHOOK_TOLERANCE_SECONDS` is unused. No age/future-date rejection; Basic has no expiration. Altered event keys bypass deduplication. |
| Duplicate/out-of-order webhook regression | Incorrect status, terminal reversal | Unique event insert; older timestamps rejected; terminal states protected once `last_event_at` exists; equal timestamps use status rank | Newer nonterminal events can have a lower status rank. A terminal row without event time can be overwritten. No full allowed-transition graph. |
| Concurrent callbacks / partial writes | History and projection diverge | Optimistic projection update compares previous timestamp and retries twice | Insert, receipt touch, projection, and audit are separate writes. Crash after insert can leave a duplicate that never updates projection. Equal-timestamp concurrency has weaker conflict detection. Queue/outbox/transactional processing is future work. |
| Payload bombs / oversized bodies | Memory/CPU/database exhaustion | 64 KiB callback limit, 1 MiB general HTTP limit, JSON parsing and Zod validation, metadata depth/string truncation | No comprehensive field-length/nesting limits before parsing; free-form extra fields enter memory. Proxy limits/timeouts required. Oversized HTTP bodies produce 413. |
| Log injection/exfiltration | Sensitive data in logs or misleading evidence | Structured Pino logging, configured redaction, recursive audit sanitization, disabled automatic request logging | Incoming request IDs and free-text event fields are not comprehensively normalized; unknown event names are stored separately. Redaction is heuristic. Restrict log viewers/exports. |
| Secret leakage via errors or tool output | Credential compromise | Safe application errors, fixed tool fields/summaries, no raw exception causes or callback payload output | Merchant data comes from trusted storage, not a content classifier. Any future logging/output path needs review; process/env compromise exposes secrets. |
| SSRF through webhook/token endpoints | Internal network access or token exfiltration | Callback payload URLs are not fetched; token endpoint accepts credentials/grant fields, not a caller-selected outbound URL; provider ID is URL-encoded in dormant client | OIDC discovery URLs and returned endpoints, and Drive base URL, lack strict host/HTTPS allowlists. Compromised configuration/IdP can redirect egress. Apply egress policy; OIDC fetches have no explicit timeout. |
| DoS from MCP calls/webhook floods | Resource starvation | In-process fixed-window limiter: HTTP MCP per combined tenant/user key; callbacks per IP; body limits | Limits reset per process/restart and do not aggregate tenants. OAuth endpoints have no limiter, unauthenticated MCP verification occurs before its limiter, and stdio bypasses it. Add edge/shared controls. |
| Insider access to PostgreSQL | Read metadata/identity, modify access/status/audit | Parameterized queries; HMAC provider-ID tokens and optional AES-GCM encrypted copies with key configured | Most fields remain plaintext at application level; keys are environment-backed. No RLS, tamper-proof audit, or implemented KMS. Use least privilege, separate keys, storage encryption, and access auditing. |
| Ineffective integration/session revocation | Compromised access persists | Repository can mark an integration disabled; identity/access mappings are queried for reads | Disabled flag is not checked by read or ingest; no hosted session invalidation. Block ingress/stop workloads/revoke mappings and provider credentials for containment. |
| Lost audit evidence | Incomplete investigation | Sanitized audit records and operational logging | Audit persistence failures are swallowed. Pre-tool auth denials and unknown callbacks lack tenant audit rows; tool/ingress request IDs differ. Monitor failures and retain external evidence. |
| Wrong environment or key rotation | Cross-environment contamination or lost ID matching | Production config checks; explicit sandbox/production environment values | Environment setting does not isolate traffic or select a URL. Changing the database key breaks existing hashes/ciphertext without migration. Isolate deployments and coordinate rotation. |

## Operational priorities

Before production, complete managed-secret wiring, effective revocation, timestamp replay policy, OIDC provider compatibility, and durable projection/audit consistency. Apply HTTPS and restricted egress, proxy-level token/auth rate limits, and protected PostgreSQL/log storage. Shared rate limiting, queue/outbox processing, and provider refresh are future extensions, not current defenses.

Use the [production checklist](README.md#production-deployment-checklist), [incident runbook](README.md#credential-rotation-and-incident-response), and [security policy](SECURITY.md). Retention is an operational policy; no automatic deletion worker exists.
