# Legacy Drive architecture

Historical Drive/HTTP scope only. See [architecture.md](architecture.md) for the consumer server.

## Components

Node.js 22+, strict TypeScript, the official MCP TypeScript SDK, Fastify, Zod, Pino, `jose`, and a repository abstraction over PostgreSQL/PGlite form the application. `src/runtime.ts` assembles dependencies; `src/index.ts` loads dotenv, selects transport, and manages shutdown.

| Component | Source | Responsibility |
| --- | --- | --- |
| Configuration | `src/config/env.ts` | Defaults, environment validation, production checks, derived URLs/database driver. |
| HTTP | `src/http/server.ts` | Stateless `POST /mcp`, error envelopes, body limits, health/readiness. |
| Identity adapters | `src/auth/` | Development PKCE flow, OIDC code exchange/JWT verification, identity mapping and scope helpers. |
| MCP registration | `src/mcp/` | Registers only `get_delivery_status`; wraps success and safe errors; audits execution. |
| Domain | `src/domain/` | Normalization, timestamp/rank transition guard, freshness, safe summaries, authorized presentation. |
| Callback adapters | `src/doordash/webhook-*.ts` | Basic/OAuth verification, token issuance, payload parsing/minimization. |
| Callback ingestion | `src/webhooks/` | Rate-limited ingress, known-delivery matching, event deduplication and projection updates. |
| Drive client/JWT | `src/doordash/client.ts`, `src/doordash/jwt.ts` | Server-only GET client and short-lived in-memory JWT cache; not wired into runtime reads. |
| Persistence | `src/db/`, `migrations/0001_init.sql` | Parameterized repositories, PostgreSQL/PGlite drivers, explicit migrations. |
| Secrets/crypto | `src/secrets/`, `src/crypto/field-crypto.ts` | Environment provider, cloud adapter stub, ID hashing and optional AES-GCM. |
| Rate limiting | `src/ratelimit/` | `RateLimiter` interface and in-memory fixed one-minute windows. |
| Audit/logging | `src/audit/`, `src/logging/` | Sanitized best-effort audit writes and redacted structured logs. |
| Local workflow | `scripts/seed-dev.ts`, `scripts/simulate-webhook.ts`, `fixtures/webhooks/` | Dev access linking and deterministic callback simulation. |

There is no Docker workflow or external-service requirement locally. `DATABASE_URL` selects standard PostgreSQL; otherwise PGlite persists to `PGLITE_DATA_DIR` (default `.data/pglite`). Redis is not implemented or required.

## MCP request flow

1. Fastify receives `POST /mcp` (general body limit 1 MiB) and assigns an incoming `x-request-id` or generated UUID.
2. It parses one Bearer header and calls the selected identity provider for token verification. OIDC verifies signed JWTs using discovered JWKS, exact issuer/audience, expiration, and mapped identity/scope claim types.
3. `resolveAuthContext` looks up the tenant by its internal ID, then the user by `(tenant_id, external_subject)`. Both must already exist. Only known scopes survive resolution.
4. The HTTP limiter consumes a budget for `${tenantId}:${userId}`. This is a combined key, not separate aggregate tenant and user quotas; every HTTP MCP POST, including protocol requests, consumes it.
5. A new MCP server and stateless Streamable HTTP transport are created for the request, with JSON responses and no session ID generator. GET/PUT/DELETE `/mcp` return 405.
6. `get_delivery_status` validates a nonempty string input and checks `deliveries:read`. Its domain service requires a UUID, joins through the current user's access record, and checks tenant equality. All lookup failures share the generic message.
7. The domain presents nine safe fields with freshness based on `last_event_at`, not receipt time. It does not check integration status or call the provider.
8. The tool records a success/denied/error audit with a **new tool-local request ID**. Success returns text JSON plus `structuredContent`; caught errors return `isError` and safe text only. Cleanup closes the per-request MCP server when the response closes.

Stdio instead auto-provisions a local development context with read scope, connects `StdioServerTransport`, and does not listen for HTTP/webhooks. It is forbidden in production and lacks HTTP authentication/rate limiting.

### OAuth flow and endpoint details

`GET /oauth/authorize` accepts code flow, a secure redirect URI (HTTPS or loopback HTTP without credentials/fragment), nonempty state, a 43-character S256 challenge, optional client ID, and requested scopes. `/oauth/token` accepts authorization-code exchange and a 43–128-character verifier. Form parsers reject duplicate keys.

The dev adapter stores one-time five-minute codes and uses an ephemeral signing key; it has no user login. OIDC redirects to issuer `/authorize` and discovers only token/JWKS endpoints for subsequent operations. It does not use discovered authorization endpoint metadata or add vendor-specific audience parameters. Public clients with `token_endpoint_auth_method=none` are the advertised model. No refresh, introspection, dynamic registration, or revocation endpoint exists.

`/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource` advertise the server's URLs and both known scopes. Advertising `deliveries:list` does not register a tool. See [README authorization setup](../README.md#remote-http-with-an-oidc-identity-provider).

## Webhook ingest flow

1. `POST /webhooks/doordash/delivery-status` consumes an in-process budget by `request.ip`; raw-body parsing is capped at 65,536 bytes. Fastify does not trust forwarded IPs by default.
2. The isolated verifier compares the configured full Basic Authorization value in constant time, or verifies an independently issued webhook OAuth token. It does not use `rawBody` for a signature. OAuth tokens come from `POST /webhooks/oauth/token` using `client_credentials`, via body credentials or HTTP Basic, not both.
3. JSON parsing and Zod validation require nonempty `event_name` and `external_delivery_id`. Optional recognized timestamps must parse as dates. Additional fields are accepted into memory but excluded from the stored subset.
4. Occurrence time is `updated_at`, then `created_at`, then receipt time if both are absent. The event key is SHA-256 of `event_name|external_delivery_id|created_at-or-updated_at-or-empty`. This is deterministic deduplication, not an authentication signature. No provider-supplied event ID is used.
5. The provider ID is HMAC-SHA-256-tokenized with the configured key (plain SHA-256 locally without it). Lookup uses the globally unique hash. Unknown deliveries return `ignored` and an operational log; they are not created or audited under a tenant. Integration status/environment is not consulted.
6. Normalization maps the event and bounds ETA to event time minus one minute through plus 48 hours. The stored allowlist includes event name, created/updated times, pickup/dropoff estimated/actual times, cancellation reason, and contactless flag; recursive redaction is applied. Raw bodies, provider IDs, and arbitrary extra fields are not stored in this subset.
7. `delivery_events.insertIfAbsent` uses the unique `provider_event_id` digest. A conflict returns `duplicate`. A newly inserted event touches `last_received_at`, even if its projection is later rejected.
8. The service reloads the current projection, applies the transition decision, and conditionally updates by expected `last_event_at`. It makes at most two attempts. Rejected/contended updates return `stale`; successful updates return `applied`. Event history remains even when state is unchanged.
9. Known-delivery outcomes are logged and audited with ingress request ID, event type, normalized status, and transition reason. `applied` is audited as `success`. The route returns HTTP 200 with `{"status":"<outcome>"}` for all four successful processing outcomes.

**Consistency limits:** event insertion, receipt touch, projection update, and audit are not one transaction. A failure after insertion can leave history without a projection; replay is then a duplicate. Comparing only timestamps also gives weaker conflict detection for concurrent equal-timestamp updates. Audit errors are swallowed after safe logging. No queue/outbox, durable retry worker, or replay-age policy is wired in. `DOORDASH_WEBHOOK_TOLERANCE_SECONDS` is parsed but unused, so old/future timestamps are not rejected at ingress.

### Transition policy

If `last_event_at` exists, terminal `delivered`/`cancelled` states reject all later events; older event times are rejected; equal times advance only to a strictly higher rank. If there is no stored event time, the incoming projection is accepted, even when the stored status is terminal. Newer events on nonterminal projections are accepted regardless of rank. This prevents older-event regression but is not a complete allowed-transition graph.

Equal-time ranks are: `unknown` 0, `scheduled` 10, `searching_for_driver` 20, `driver_assigned` 30, `at_restaurant` 40, `preparing_or_waiting` 45, `picked_up` 50, `out_for_delivery` 60, `arrived` 70, `issue` 75, `delivered` 80, `cancelled` 85.

## Normalization mapping

The following Drive webhook event names map exactly as implemented in `src/domain/status-mapping.ts`. Matching is case-insensitive. Confirm enabled event types against the official Drive documentation for the registered integration; this table documents the adapter, not a separate provider compatibility certification.

| Drive webhook event | Normalized status |
| --- | --- |
| `DASHER_CONFIRMED` | `driver_assigned` |
| `DASHER_CONFIRMED_PICKUP_ARRIVAL` | `at_restaurant` |
| `DASHER_PICKED_UP` | `picked_up` |
| `DASHER_CONFIRMED_DROPOFF_ARRIVAL` | `arrived` |
| `DASHER_DROPPED_OFF` | `delivered` |
| `DELIVERY_CANCELLED` | `cancelled` |
| `DELIVERY_RETURN_INITIALIZED` | `issue` |
| `DASHER_CONFIRMED_RETURN_ARRIVAL` | `issue` |
| `DELIVERY_RETURNED` | `issue` |
| `DELIVERY_BATCHED` | `searching_for_driver` |
| `DASHER_ENROUTE_TO_PICKUP` | `driver_assigned` |
| `DASHER_ENROUTE_TO_DROPOFF` | `out_for_delivery` |
| `DASHER_ENROUTE_TO_RETURN` | `issue` |

If the event name has no mapping, the mapper tries these provider-status strings:

| Provider status | Normalized status |
| --- | --- |
| `created` | `scheduled` |
| `confirmed`, `enroute_to_pickup` | `driver_assigned` |
| `arrived_at_pickup` | `at_restaurant` |
| `picked_up` | `picked_up` |
| `enroute_to_dropoff` | `out_for_delivery` |
| `arrived_at_dropoff` | `arrived` |
| `delivered` | `delivered` |
| `cancelled` | `cancelled` |
| `returned` | `issue` |

Otherwise the result is `unknown`. The callback parser currently sets `providerStatus` to `event_name`; it does not consume a separate `delivery_status` webhook field. `preparing_or_waiting` is a supported internal state without a direct mapping. The full field/freshness contract is in [MCP tools](mcp-tools.md).

## Persistence and secrets

`migrations/0001_init.sql` creates tenants; users unique by tenant/subject; active/disabled sandbox/production integration records; deliveries with unique provider-ID hash, optional ciphertext, merchant/status/ETA and timestamps; delivery-access links; unique-key normalized event history; and audit logs. Foreign keys govern deletion. There is no database RLS policy or integration foreign key on delivery rows.

The seed creates a delivery/access link for the dev identity, uses optional field encryption, and prints its internal reference. It does not create an integration record. Callback ingestion only updates existing delivery projections. Production provisioning is an external trusted administrative task.

Migrations execute sorted SQL files in a transaction and track names in `schema_migrations`. `npm run db:migrate` is explicit; runtime does not run migrations. All entry points, including the migration CLI, load `.env` when present. Seed runs migrations itself.

`SecretProvider` separates consumers from retrieval. The environment implementation is always selected by the runtime factory. `CloudSecretProvider` accepts a logical-name fetcher but has no concrete managed-store adapter or factory wiring. HMAC tokenization and AES-GCM use Node crypto; managed KMS/envelope encryption is deployment work. See [Security](../SECURITY.md).

## Config surface summary

| Area | Variables / current behavior |
| --- | --- |
| Process/transport | `NODE_ENV`, `HOST`, `PORT`, `MCP_TRANSPORT`; CLI `--stdio` overrides transport. |
| Persistence | `DATABASE_URL`, `PGLITE_DATA_DIR`, `DATABASE_ENCRYPTION_KEY`; production requires database URL and key. |
| Identity | `AUTH_MODE`, `MCP_ISSUER_URL`, `MCP_RESOURCE_URL`, `OIDC_ISSUER_URL`, `OIDC_AUDIENCE`, `OIDC_TENANT_CLAIM`, `OIDC_SUBJECT_CLAIM`, `OIDC_SCOPE_CLAIM`, `DEV_TENANT_ID`, `DEV_TENANT_NAME`, `DEV_USER_ID`. |
| Drive | `DOORDASH_ENVIRONMENT`, `DOORDASH_DEVELOPER_ID`, `DOORDASH_KEY_ID`, `DOORDASH_SIGNING_SECRET`, `DOORDASH_API_BASE_URL`, `DOORDASH_API_TIMEOUT_MS`, `DOORDASH_API_MAX_RETRIES`; client not wired into reads. |
| Callbacks | `DOORDASH_WEBHOOK_AUTH_MODE`, `DOORDASH_WEBHOOK_BASIC_AUTH`, `DOORDASH_WEBHOOK_OAUTH_CLIENT_ID`, `DOORDASH_WEBHOOK_OAUTH_CLIENT_SECRET`, `DOORDASH_WEBHOOK_OAUTH_TOKEN_TTL_SECONDS`; `DOORDASH_WEBHOOK_TOLERANCE_SECONDS` is unused. |
| Rate/observability | `RATE_LIMIT_TOOL_PER_MINUTE`, `RATE_LIMIT_WEBHOOK_PER_MINUTE`, `LOG_LEVEL`; limiter state is local to each process, token endpoints unmetered. |
| Presentation | `STATUS_DELAYED_AFTER_SECONDS`, `STATUS_STALE_AFTER_SECONDS`; `RECENT_DELIVERED_WINDOW_HOURS` affects only internal listing. |

Exact defaults, conditional requirements, scripts, and placeholder examples are in the [README environment table](../README.md#environment-configuration) and `.env.example`. URL configuration is not a comprehensive HTTPS/host allowlist; deployment must constrain it.

## Future extensions — not implemented as exposed features

- **`list_active_deliveries`:** internal service/repository filtering exists (default active records; optional recent terminal records), but no MCP tool registration. Help is deferred too.
- **Optional provider refresh:** Drive client/JWT modules exist, but runtime does not construct or call them. The client has a source TODO to confirm official GET path/version/response fields. It implements a timeout, 0–5 retries on transport failures/429/5xx, and bounded exponential backoff with jitter; these do not refresh current tool results.
- **Redis/shared rate limiter:** `RateLimiter` is the seam; only the in-memory implementation exists. No external Redis service, shared quota, or distributed replay cache is configured.
- **Queue/outbox:** no queue, outbox, durable worker, or atomic event-to-projection handoff exists. Current callback processing awaits database writes in the request.
- **Production hardening:** managed-secret adapter wiring, integration-disable enforcement, replay-age checks, session/token revocation integration, automated retention, and end-to-end audit correlation remain gaps rather than completed capabilities.

These extensions must preserve read-only authorization, data minimization, and the official Drive-only boundary. No consumer-account or order-writing capability is implied.
