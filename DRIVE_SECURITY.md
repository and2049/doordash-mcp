# Legacy Drive security policy

Historical scope: Drive server only. The active consumer security policy is [SECURITY.md](SECURITY.md).

## Scope and reporting

This is an authorized, read-only status service for official DoorDash Drive integrations. It never supports consumer passwords, cookie import, consumer scraping, private APIs, or order mutation. Only `get_delivery_status` is exposed.

Report suspected vulnerabilities privately to the repository maintainers using the hosting platform's private vulnerability-reporting feature if enabled. No dedicated security email, response SLA, or private-reporting URL is configured in this repository. If no private channel is published, ask a maintainer for one without posting exploit details or sensitive data publicly.

Include affected version/revision, component, impact, sanitized reproduction steps, and relevant request IDs. Use synthetic accounts and fixtures. Do not include access tokens, signing secrets, webhook credentials, database URLs containing passwords, raw webhook payloads, or personal delivery data. Coordinate disclosure with maintainers after remediation.

## Secret handling rules and implementation

- DoorDash signing secrets and webhook verification secrets must never be logged, returned to MCP clients, placed in prompts, or stored in PostgreSQL. DoorDash API JWTs must never be returned to clients or persisted. They are sent only to the configured Drive API by the server-side client.
- OAuth access tokens must never appear in logs, database records, errors, or MCP tool output. The necessary exception to “never returned” is their intended OAuth token exchange: `/oauth/token` returns the MCP client's token, and `/webhooks/oauth/token` returns a callback token to the authenticated webhook client. These responses use `Cache-Control: no-store`; the MCP token route also sets `Pragma: no-cache`.
- `src/doordash/jwt.ts` signs HS256 JWTs with `jose` (`dd-ver: DD-JWT-V1`), defaults to 900 seconds, caps requested TTL at 1800 seconds, and refreshes when less than 60 seconds remain. Cache entries are in process memory, keyed by integration ID or null. There is no persistent token cache or explicit invalidation API. The module is not wired into runtime status reads.
- Development auth signing keys and authorization codes are in memory. Webhook OAuth tokens default to 300 seconds, with a configurable maximum of 3600, and use a standard HKDF-derived signing key and `jose` verification.
- Never commit `.env`, dump process environments, log full headers, or put secrets in command-line arguments. Use placeholder-only documentation and synthetic fixtures. Do not log arbitrary exception causes or raw payloads.

### Secret providers

`SecretProvider` exposes `getDoorDashSigningSecret(integrationId)`, `getWebhookVerificationSecret()`, and `getDatabaseEncryptionKey()`.

`EnvironmentSecretProvider` is intended for **local development only**. It reads configured environment values, supports integration-scoped signing-secret overrides, and does not log secret values. **The current `createSecretProvider` factory always selects it, including in production.** Startup also requires production secrets in environment configuration. This is an implementation gap, not managed secret support.

`CloudSecretProvider` is an adapter stub around `SecretFetcher.getSecret(name)`. No cloud SDK, workload authentication, secret-name deployment mapping, cache/rotation policy, or runtime selection is supplied.

| Managed store | Required adapter work (TODO) |
| --- | --- |
| AWS Secrets Manager | Map logical names to approved secret ARNs/versions; use workload IAM limited to those reads and necessary KMS decrypt permissions. |
| GCP Secret Manager | Map logical names to explicit project/secret/version resources; grant the workload access only to required secrets. |
| Azure Key Vault | Map logical names to vault secret identifiers/versions; use managed identity with narrowly scoped secret-read access. |
| HashiCorp Vault | Map logical names to approved mount/path/version; use workload auth and read-only path policies with bounded leases. |

Logical names include `DOORDASH_SIGNING_SECRET`, its normalized integration-specific variant, `DOORDASH_WEBHOOK_BASIC_AUTH` or `DOORDASH_WEBHOOK_OAUTH_CLIENT_SECRET`, and `DATABASE_ENCRYPTION_KEY`. Complete the adapter, factory wiring, and startup-validation changes before claiming managed-secret production operation. Grant no broad secret-listing/admin rights; keep secret access auditable and sandbox/production separate.

## Encryption at rest

With `DATABASE_ENCRYPTION_KEY` (base64-encoded 32 bytes), `hashProviderId` uses HMAC-SHA-256 to tokenize provider identifiers. Without the key it falls back to unkeyed SHA-256 for local development; that is weaker against guessed identifiers. The key is optional locally and required in production.

`encryptString` / `decryptString` use Node's standard AES-256-GCM implementation, a random 12-byte IV, authentication tag, and versioned field encoding. The seed stores an encrypted provider-ID copy only when a key exists. Repository methods accept already-tokenized/encrypted identifiers; they do not automatically encrypt every field. Merchant names, identity mappings, event metadata, and status timestamps are not covered by this field encryption.

Use standard cryptographic libraries, **not custom cryptography**. Require storage-level encryption, TLS, least-privilege database roles, and managed KMS/envelope encryption in production. Keep key material separate from database data and backups. KMS wrapping, envelope encryption, key versioning, and migration/rotation automation are **not implemented**. Rotating the existing key requires updating both ID tokens and ciphertext; see the [runbook](README.md#credential-rotation-and-incident-response).

## Data minimization and logging

The application does not intentionally persist consumer credentials/cookies/tokens, payment details, driver phone numbers or identities, exact addresses, live-location history, or raw webhook bodies. Callback bodies temporarily enter memory. Fixture files deliberately contain synthetic examples of sensitive fields to exercise their removal.

The stored event subset allows `event_name`, `created_at`, `updated_at`, pickup/dropoff estimated and actual timestamps, `cancellation_reason`, and `contactless`; it passes through recursive redaction. Event type/provider status and a deterministic event digest are also stored. Provider IDs are tokenized; delivery references are internal UUIDs. The seed supplies merchant names, and callback merchant names do not update that field. Tool output contains only the nine fields in the [tool reference](docs/mcp-tools.md).

Pino redacts configured secret/header fields. Audit metadata redaction masks sensitive key names, recognizable JWT/Basic/Bearer strings, caps string length at 512, and limits nesting depth. Request auto-logging is disabled. These mechanisms are not general-purpose content classification: secrets or personal data disguised in free-text event names, cancellation reasons, merchant names, or request IDs may evade them. Event type/provider status are stored separately from redacted metadata. Trusted provisioning, upstream schema discipline, and controlled log access remain necessary.

Audit logs are best-effort: database failures are logged and swallowed. Tool audit entries use a newly generated request ID rather than propagating the HTTP ingress ID. Unknown-delivery callbacks are logged but not inserted into tenant audit history. Do not advertise a complete, immutable audit trail.

Use the [retention recommendation](README.md#data-retention); no purge worker exists. Protect database dumps, backups, log exports, and local `.data/pglite` with the same access controls as application data.

## Authentication boundaries

1. **MCP client → server:** OIDC JWT verification, internal tenant/subject mapping, `deliveries:read`, a delivery-access join, and tenant equality gate HTTP tool reads. The dev provider and stdio mode are unsafe for hosted production.
2. **Server → DoorDash:** separate service credentials mint server-only Drive JWTs. MCP client OAuth is never forwarded to DoorDash or used as a Drive credential. The optional client module is currently disconnected from reads.
3. **DoorDash → webhook ingress:** constant-time expected-header comparison in Basic mode, or independently issued/verifiable webhook OAuth tokens. Neither mode signs/binds each payload body. A valid callback updates only an already-known tokenized delivery ID.

The callback timestamp-tolerance variable is unused. Duplicate persistence prevents applying an identical event twice, but there is no cryptographic per-message replay window; timestamps can be missing or future-dated. The integration `disabled` flag is not enforced in the read/ingest paths. OIDC revocation/introspection and token denylists are absent. These limits and effective containment steps are explicit in the [threat model](THREAT_MODEL.md) and [incident runbook](README.md#credential-rotation-and-incident-response).

## Production requirements

Use managed secrets and workload identity, HTTPS at every external boundary, trusted egress destinations, private/TLS database access, KMS/envelope encryption, tested credential rotation and fast revocation, and edge/shared rate limiting. Remove compromised local access mappings or block ingress for immediate containment; an IdP session revocation or integration database flag alone is insufficient here. Complete the identified runtime gaps before exposing a production multi-tenant service. No security certification or completed production-readiness assessment is implied by these documents.
