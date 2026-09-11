# Legacy Drive server (historical)

Archived documentation for `src/index.ts` and the Drive HTTP/stdio server only. It does not describe the current consumer MCP. Use [README.md](README.md) and [consumer tools](docs/consumer-tools.md) for consumer accounts and ordering.

A read-only MCP server for delivery-status updates that an authenticated user is authorized to view. **Exactly one MCP tool is exposed: `get_delivery_status`.** It reads stored, webhook-derived status; it does not call DoorDash on each invocation.

This project does **not** support consumer-account scraping, consumer passwords, browser-cookie import, or reverse-engineered/private APIs. The integration boundary is the **official DoorDash Drive API only**. It cannot place, change, or cancel orders. It does not expose driver contact details, addresses, coordinates, or payment data.

`list_active_deliveries` is planned and not yet exposed, although internal listing types and repository/service methods exist. `get_delivery_status_help` is also deferred.

## Local setup

Use Node.js 22+ and npm, from the project root:

```sh
npm install
cp .env.example .env
npm run db:migrate
npm run seed:dev
npm run dev
```

The `cp .env.example .env` step is optional for the default database and development identity. It supplies the matching placeholder webhook header needed by the local simulator. All credential strings in `.env.example` are placeholders, not usable DoorDash credentials. Keep real values out of version control.

The HTTP listener defaults to `http://127.0.0.1:8080`; the MCP endpoint is `POST /mcp`. `/healthz` reports process health and `/readyz` checks the database with `select 1`.

`seed:dev` loads `.env`, runs migrations, ensures the development tenant and user, creates or reuses a delivery, and grants that user a `customer` relationship in `delivery_access`. It prints JSON containing `tenant_id`, the internal `user_id`, and the opaque UUID `delivery_ref`. Save that reference for tool calls. `DEV_USER_ID` is the user's **external subject**, not the generated internal UUID. The default seeded provider identifier is `dev-delivery-0001`, and the merchant is `Dev Merchant`. No integration row or real DoorDash delivery is created.

Run migrations and seeding before starting a process using the same embedded database directory. Runtime startup does not automatically migrate. All entry points, including the migration CLI, load `.env` when present.

### Local data and production PostgreSQL

When `DATABASE_URL` is unset, development uses embedded PostgreSQL via **PGlite**, persisting in `.data/pglite` by default. No Docker, separate PostgreSQL server, Redis, or other external service is needed for local development. `PGLITE_DATA_DIR` selects another directory; `:memory:` is ephemeral. Treat a disk directory as belonging to one running process.

Set `DATABASE_URL` to a standard PostgreSQL connection string to use the `pg` connection pool instead. It is required when `NODE_ENV=production`. Arrange database TLS and access controls through the connection configuration and hosting platform; the application does not provision PostgreSQL.

`DATABASE_ENCRYPTION_KEY` is optional locally but **required in production**. It must decode from base64 to exactly 32 bytes. With it, provider IDs are HMAC-SHA-256-tokenized; the seed also stores their AES-256-GCM-encrypted form. Without it, local IDs use unkeyed SHA-256 and no encrypted copy. Field encryption is not whole-database encryption. See [Security](SECURITY.md) before changing this key for an existing database.

## Environment configuration

`.env.example` is the copyable local template; validation and defaults are in `src/config/env.ts`. Angle-bracket values below are placeholders to replace privately, not valid secrets. No variables must be supplied for default local startup. Feature-specific requirements follow.

| Variables | Defaults or placeholder configuration | Requirement / effect |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test`, or `production`; production enables additional checks. |
| `HOST`, `PORT` | `127.0.0.1`, `8080` | HTTP bind address and port. |
| `MCP_TRANSPORT` | `http` | `http` or `stdio`; `--stdio` overrides it. |
| `DATABASE_URL` | `postgresql://<db-user>:<db-password>@<db-host>:5432/<db-name>` | Optional locally; required in production. |
| `PGLITE_DATA_DIR` | `.data/pglite` | Used only without `DATABASE_URL`. |
| `DATABASE_ENCRYPTION_KEY` | `<base64-encoded-32-byte-key>` | Optional locally; required in production. |
| `AUTH_MODE` | `dev` | `oidc` required in production. |
| `MCP_ISSUER_URL` | `https://<mcp-host>` | Optional; defaults to local HTTP bind-derived origin. Set public HTTPS origin remotely. |
| `MCP_RESOURCE_URL` | `https://<mcp-host>/mcp` | Optional; defaults to issuer URL plus `/mcp`. |
| `OIDC_ISSUER_URL`, `OIDC_AUDIENCE` | `https://<idp-host>/`, `https://<mcp-host>/mcp` | Both required for `AUTH_MODE=oidc`. |
| `OIDC_TENANT_CLAIM`, `OIDC_SUBJECT_CLAIM`, `OIDC_SCOPE_CLAIM` | `tenant_id`, `sub`, `scope` | Top-level access-token claim names. |
| `DEV_TENANT_ID` | `<development-tenant-uuid>` | Optional UUID; use the template's synthetic default consistently. |
| `DEV_TENANT_NAME`, `DEV_USER_ID` | `Development Tenant`, `dev-user` | Local identity only; defaults supplied. |
| `DOORDASH_ENVIRONMENT` | `sandbox` | `sandbox` or `production`; does not automatically switch URLs or credentials. |
| `DOORDASH_DEVELOPER_ID`, `DOORDASH_KEY_ID`, `DOORDASH_SIGNING_SECRET` | `<developer-id>`, `<key-id>`, `<signing-secret>` | Required for Drive JWT minting and production startup; not needed for local status reads. |
| `DOORDASH_API_BASE_URL` | `https://openapi.doordash.com/drive/v2` | Template and client fallback; client is not wired into status reads. |
| `DOORDASH_API_TIMEOUT_MS`, `DOORDASH_API_MAX_RETRIES` | `5000`, `2` | Client timeout and bounded retries (0–5). |
| `DOORDASH_WEBHOOK_AUTH_MODE` | `basic` | `basic` or `oauth`. |
| `DOORDASH_WEBHOOK_BASIC_AUTH` | `<full-expected-Authorization-header>` | Required for Basic webhook acceptance; required at production startup in Basic mode. |
| `DOORDASH_WEBHOOK_OAUTH_CLIENT_ID`, `DOORDASH_WEBHOOK_OAUTH_CLIENT_SECRET` | `<webhook-client-id>`, `<webhook-client-secret>` | Both required at startup in OAuth webhook mode. |
| `DOORDASH_WEBHOOK_OAUTH_TOKEN_TTL_SECONDS` | `300` | Positive integer, maximum 3600. |
| `DOORDASH_WEBHOOK_TOLERANCE_SECONDS` | `86400` | Parsed but currently unused: no event-age rejection is enforced. |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, or `silent`. |
| `RATE_LIMIT_TOOL_PER_MINUTE` | `60` | HTTP MCP requests per combined tenant/user key, per process. |
| `RATE_LIMIT_WEBHOOK_PER_MINUTE` | `600` | Delivery webhook requests per request IP, per process. |
| `STATUS_DELAYED_AFTER_SECONDS`, `STATUS_STALE_AFTER_SECONDS` | `180`, `900` | Provider-event age thresholds; configure delayed lower than stale. |
| `RECENT_DELIVERED_WINDOW_HOURS` | `24` | Internal listing window; no list tool is exposed. Not a retention policy. |

The local secret provider also supports `DOORDASH_SIGNING_SECRET_<NORMALIZED_INTEGRATION_ID>` overrides, with the ID uppercased and non-alphanumeric characters replaced by underscores. These are not part of the template or a hosted integration-management workflow.

## MCP transports and authorization

### Local stdio

Instead of HTTP, run:

```sh
npm run dev:stdio
```

Configure a local MCP client to launch `npm` with arguments `run`, `dev:stdio`, with its working directory set to this project. On Windows, use `npm.cmd` if required by the client. Set `AUTH_MODE=dev`, `DEV_USER_ID=<development-subject>`, and `DEV_TENANT_ID=<development-tenant-uuid>` in the client's environment, matching the seed identity. The template defaults also work. `MCP_TRANSPORT=stdio` is an alternative to the script's `--stdio` flag.

**Stdio is development-only and unsafe as a substitute for hosted authentication.** It auto-provisions the local identity with `deliveries:read`; it has no per-request OAuth verification or HTTP rate limiting, and does not start a webhook listener. Production rejects stdio. Main-process logs go to stderr.

### HTTP with the development identity provider

Run `npm run dev` with `AUTH_MODE=dev`, seed first, and point an MCP client supporting Streamable HTTP and Authorization Code + PKCE at `http://127.0.0.1:8080/mcp`. Request `deliveries:read`.

The development provider has **no real login or consent**: it issues a code for the configured dev identity. It accepts S256 PKCE, binds the code to the redirect URI and client ID, and uses one-time, five-minute codes and one-hour access tokens. Its signing key and authorization codes are process-memory-only. Restart invalidates them. Keep this mode on loopback; production rejects it. HTTP token verification requires an existing tenant/user mapping, which `seed:dev` provides.

### Remote HTTP with an OIDC identity provider

Auth0, Clerk, Okta, Cognito, or a self-hosted OIDC provider may supply identity, provided its configuration matches this adapter's capabilities:

1. Register a public Authorization Code client with S256 PKCE and exact allowed client callback URIs at the IdP. There is no dynamic client-registration endpoint or confidential-client secret support here.
2. Configure an API/resource audience and grant `deliveries:read` only to authorized clients/users. The IdP must issue signed JWT access tokens; opaque-token introspection is not implemented.
3. Set `AUTH_MODE=oidc`, `OIDC_ISSUER_URL=<exact-issuer-url>`, `OIDC_AUDIENCE=<expected-access-token-audience>`, and the public `MCP_ISSUER_URL` / `MCP_RESOURCE_URL`. Use HTTPS for remote deployment.
4. Map `OIDC_TENANT_CLAIM` to the internal tenant UUID and `OIDC_SUBJECT_CLAIM` to the user's stable external subject. Pre-provision a `tenants` row and matching `users(tenant_id, external_subject)` row through trusted administration. There is no production provisioning API. A tenant claim array uses only its first element.
5. Map `OIDC_SCOPE_CLAIM` to a whitespace-delimited string or string array. Unknown scopes are discarded when resolving the internal auth context. `deliveries:list` is advertised but grants no currently exposed list tool.
6. Provision deliveries and `delivery_access` links through a trusted integration workflow. Webhooks only update known deliveries; they do not create them or grant ownership.

The server exposes:

| Endpoint | Behavior |
| --- | --- |
| `GET /oauth/authorize` | Validates code-flow/S256 parameters and redirects through the selected identity adapter. |
| `POST /oauth/token` | Exchanges an authorization code and PKCE verifier; accepts JSON or form encoding; returns tokens with no-store headers. |
| `GET /.well-known/oauth-authorization-server` | Advertises local authorization/token endpoints, code flow, S256, and known scopes. |
| `GET /.well-known/oauth-protected-resource` | Advertises the MCP resource and local authorization-server URL. |
| `POST /mcp` | Verifies a Bearer access token on every HTTP request; uses stateless Streamable HTTP with JSON responses. |

The OIDC adapter discovers `token_endpoint` and `jwks_uri` from the issuer's `/.well-known/openid-configuration`, checks the discovery issuer, and verifies access-token signature, issuer, audience, expiration, and identity/scope claim types. **Authorization redirects currently use `<OIDC_ISSUER_URL>/authorize`, not the discovered `authorization_endpoint`.** Verify compatibility with your provider; vendor-specific authorize paths or audience/resource query parameters require adapter work. This is not a claim of out-of-the-box compatibility with every listed vendor. Refresh-token flow, revocation/introspection, and session administration are absent.

The MCP client's OAuth token is never forwarded to DoorDash or used to mint a DoorDash JWT.

## DoorDash sandbox and webhook configuration

Use the [DoorDash developer portal](https://developer.doordash.com/) and its official Drive integration documentation to request access, register a sandbox integration, and obtain the developer ID, key ID, and signing secret. Production access and production credentials must be provisioned separately through DoorDash's official process. Do not use a consumer login. Configure the three `DOORDASH_*` credential variables privately; the server-side JWT module uses them in memory only.

The Drive client module exists, but runtime status reads use the database only. Its source has an explicit TODO to confirm the official GET endpoint/version and response fields before production use. Registering credentials alone does not import orders or activate a refresh path.

Configure separate sandbox and production webhook destinations in the DoorDash portal, using isolated deployments/databases/credentials:

| Environment | Your receiver URL |
| --- | --- |
| Sandbox | `https://<sandbox-webhook-host>/webhooks/doordash/delivery-status` |
| Production | `https://<production-webhook-host>/webhooks/doordash/delivery-status` |

These are **your ingress URLs**, not DoorDash API hosts. For sandbox callbacks to a local machine, provide a controlled HTTPS forwarding endpoint. The local fixture simulator needs no public endpoint.

Choose the portal-supported authentication mode and verify current Drive documentation for your integration:

- **Basic:** set `DOORDASH_WEBHOOK_AUTH_MODE=basic` and `DOORDASH_WEBHOOK_BASIC_AUTH=<full-expected-Authorization-header>`. Configure the identical full Basic header in the portal. The verifier compares that value in constant time; it does not compute a webhook-body signature. The local template's arbitrary matching placeholder is only for simulation.
- **OAuth:** set `DOORDASH_WEBHOOK_AUTH_MODE=oauth`, `DOORDASH_WEBHOOK_OAUTH_CLIENT_ID=<webhook-client-id>`, and `DOORDASH_WEBHOOK_OAUTH_CLIENT_SECRET=<webhook-client-secret>`. Set the portal's token endpoint to `https://<webhook-host>/webhooks/oauth/token`. DoorDash requests `grant_type=client_credentials`, with credentials either in the JSON/form body or HTTP Basic authentication, not both. The response contains `access_token`, `token_type: "Bearer"`, and `expires_in`; use the token as a Bearer header on delivery callbacks. Default TTL is 300 seconds, capped by configuration at 3600. Tokens are checked for signature, issuer, audience, subject, `iat`, and expiration.

The ingress verifies authentication before JSON/schema processing and limits callback bodies to 64 KiB. Valid duplicate events receive success with `duplicate`; older/terminal-blocked events receive `stale`. Unknown deliveries receive `ignored`. **Timestamp replay-window enforcement is not implemented**, despite the tolerance setting. See [Threat model](THREAT_MODEL.md) for replay and deployment limits.

## Fixtures and simulator

With the HTTP server running and the template's matching Basic webhook placeholder configured:

```sh
npm run simulate:webhook
```

This submits all fixtures in filename order. With only the default seed, their provider IDs are unlinked and all return `HTTP 200 {"status":"ignored"}`. To apply them to the seeded delivery:

```sh
npm run simulate:webhook -- --provider-delivery-id dev-delivery-0001
```

For a newly seeded delivery, fixtures 01–05 apply, 06 is older than the delivered event, and 07–08 are blocked by terminal-state protection; all three return `stale`. Repeating the sequence returns `duplicate` for all eight persisted events. Terminal status remains `delivered`.

For an isolated event:

```sh
npm run simulate:webhook -- --fixture 03-dasher-picked-up --provider-delivery-id dev-delivery-0001
npm run simulate:webhook -- --help
npm run seed:dev -- --help
```

The simulator supports `--url`, `--fixture` (name or path), `--provider-delivery-id`, `--loop <seconds>`, and `--secret` (full Authorization override). Prefer environment configuration over command-line secrets, which can appear in shell history/process listings. It uses Basic configuration by default and does not automatically obtain OAuth tokens. `--loop` repeats unchanged timestamps, so it demonstrates deduplication rather than live progress.

| File in `fixtures/webhooks/` | Normalized status | Original provider ID |
| --- | --- | --- |
| `01-dasher-confirmed.json` | `driver_assigned` | `fixture-delivery-001` |
| `02-dasher-confirmed-pickup-arrival.json` | `at_restaurant` | `fixture-delivery-001` |
| `03-dasher-picked-up.json` | `picked_up` | `fixture-delivery-001` |
| `04-dasher-confirmed-dropoff-arrival.json` | `arrived` | `fixture-delivery-001` |
| `05-dasher-dropped-off.json` | `delivered` | `fixture-delivery-001` |
| `06-delivery-cancelled.json` | `cancelled` | `fixture-delivery-002` |
| `07-delivery-return-initialized.json` | `issue` | `fixture-delivery-003` |
| `08-unknown-event.json` | `unknown` | `fixture-delivery-004` |

You can seed each original ID using `npm run seed:dev -- --provider-delivery-id <fixture-provider-id>` before starting the server to exercise each independently. Fixtures have fixed September 10, 2026 timestamps and synthetic sensitive fields to exercise minimization; those fields are not real personal data. The simulator does not rewrite timestamps. Output freshness depends on the actual clock.

Responses are `200` with `status` equal to `applied`, `duplicate`, `ignored`, or `stale`; malformed payloads produce `400`, bad credentials `401`, oversized bodies `413`, and exhausted ingress limits `429`. Missing Basic configuration produces `503`. The simulator prints the filename, HTTP status, and redacted response.

## Invoke `get_delivery_status`

Required scope: **`deliveries:read`**. Use the `delivery_ref` printed by `seed:dev`, or supplied by a trusted provisioning workflow. It is an internal opaque UUID, not a raw DoorDash ID.

After normal MCP initialization, send a `tools/call` request through your MCP client. For HTTP, use `/mcp`, `Authorization: Bearer <mcp-access-token>`, `Content-Type: application/json`, and the MCP client's negotiated protocol headers/Accept types.

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "get_delivery_status",
    "arguments": { "delivery_ref": "<delivery-ref-from-seed>" }
  }
}
```

Replace the reference placeholder with the actual UUID. Example output immediately after seeding (timestamp placeholder shown):

```json
{
  "delivery_ref": "<delivery-ref-from-seed>",
  "merchant_name": "Dev Merchant",
  "status": "unknown",
  "summary": "The delivery status could not be determined.",
  "eta_at": null,
  "eta_minutes": null,
  "last_updated_at": "<ISO-8601-received-timestamp>",
  "is_terminal": false,
  "data_freshness": "unknown"
}
```

The successful MCP result contains this object in `structuredContent` and its JSON serialization in a text `content` item. See [MCP tool reference](docs/mcp-tools.md) for all fields, statuses, and errors.

Freshness is based on the **accepted provider event time**, not the latest webhook receipt: `fresh` below 180 seconds, `delayed` from 180 to below 900 seconds, `stale` from 900 seconds, and `unknown` without an event timestamp. Stale summaries include an age warning. `eta_minutes` is null for stale or past estimates, but `eta_at` may still contain an old estimate; never promise that time. No polling, push notification subscription, or automatic provider refresh is implemented.

Missing, malformed nonempty UUID references, inaccessible deliveries, and tenant mismatches share exactly: **`Delivery not found or not available to this account.`** Scope denial is `forbidden`. Defined application codes are `unauthenticated`, `forbidden`, `delivery_not_found_or_unavailable`, `integration_not_configured`, `provider_unavailable`, `validation_error`, `rate_limited`, and `internal_error`. HTTP boundary errors include a code/message/request ID; caught tool errors currently return only `isError: true` and safe message text, not a machine-readable application code.

## Production deployment checklist

This implementation is production-minded, but the following integration/hardening work is required before treating it as production-ready:

- [ ] Use `NODE_ENV=production`, HTTP, OIDC JWT verification, public HTTPS issuer/resource URLs, and standard PostgreSQL via `DATABASE_URL`.
- [ ] Complete and wire a managed-secret `CloudSecretProvider` adapter. The factory currently always uses environment secrets, and production validation still requires secret environment values; do not mistake the stub for deployed secret-manager support.
- [ ] Use least-privilege workload identity, separate KMS/envelope encryption, database encryption/TLS, isolated sandbox/production secrets, and controlled key rotation.
- [ ] Terminate HTTPS at a reverse proxy; restrict direct access, enforce trusted hosts/origins, normalize request IDs, set body/time limits, and apply edge rate limits to OAuth/token endpoints as well as MCP/webhooks. Fastify does not enable `trustProxy`; callback limits may see the proxy's IP.
- [ ] Run `npm run db:migrate` against the intended database using exported settings. Preserve `migrations/` in deployment artifacts. The existing packaging scripts are `npm run build` and `npm start`; migration execution uses `tsx` and needs its tooling available.
- [ ] Pre-provision tenant/user/access links through trusted administration and verify vendor-specific OIDC authorize behavior and official Drive webhook configuration.
- [ ] Address unused webhook tolerance, missing integration-disable enforcement, and non-atomic event/projection/audit writes. Confirm the dormant Drive client's endpoint/schema before enabling it.
- [ ] Size per-process rate limits; add shared/edge enforcement before horizontal scaling. There is no independent aggregate tenant quota or token-route limiter.
- [ ] Monitor `/healthz`, `/readyz`, safe HTTP errors, webhook outcomes, rate-limit events, and audit-write failures. Audit writes are best-effort, not a transactional guarantee.
- [ ] Schedule retention/deletion and backup expiry, rehearse restore and revocation procedures, and protect logs as sensitive records.

## Credential rotation and incident response

1. **Contain:** restrict or stop affected ingress/workloads and preserve access-controlled evidence. Set affected `doordash_integrations.status` to `disabled` using trusted administration (repository `setStatus` exists, but no admin endpoint). **That flag alone currently blocks neither reads nor webhook ingestion.** Revoke delivery access/user mappings, block ingress, or stop the service for effective immediate containment.
2. **Rotate DoorDash keys:** create replacement credentials through the official portal, update the managed secret/configuration source and key ID/developer ID as applicable, redeploy, validate only authorized status traffic, and revoke the old key through DoorDash. For suspected compromise, revoke first and accept temporary downtime. The JWT cache has no explicit invalidation API; restarting clears it.
3. **Rotate webhook and application secrets:** coordinate a new Basic header or OAuth client secret with DoorDash, update all replicas, and restart. Changing the OAuth webhook secret invalidates tokens signed with the old key. Rotate database credentials and IdP credentials/keys if affected. Never paste them into incident tickets or logs.
4. **Handle database encryption-key rotation separately:** the same key controls ID HMAC lookup and encryption. Simply replacing it breaks matching for existing IDs. Plan a controlled re-encryption/re-tokenization migration using trusted original identifiers; there is no key-ring or rotation job. Local unkeyed hashes cannot recover an original ID.
5. **Invalidate sessions/access:** revoke IdP sessions and grants and remove compromised local access mappings. Existing self-contained access JWTs may remain accepted until expiry; the server has no denylist or introspection. Use ingress blocking or mapping removal for immediate revocation. Restarting invalidates development tokens/codes, but not real IdP JWTs. HTTP MCP itself is stateless.
6. **Inspect audit:** review `audit_logs` by tenant, user, action (`mcp.get_delivery_status`, `delivery_status.webhook`), outcome, timestamp, and request ID. Correlate ingress and tool records carefully: tools generate a separate request ID. Inspect sanitized `delivery_events` for duplicates, ordering anomalies, and malicious event names. Authentication failures/unknown delivery callbacks may exist only in operational logs; audit-write failures also leave gaps.
7. **Recover:** deploy rotated configuration and remediations, verify readiness and ownership restrictions, restore traffic gradually, and document impact and follow-up actions without secrets or raw payloads.

## Data retention

Recommended starting policy, subject to contractual/legal needs: delete terminal delivery records and their access/event records after **30 days**; retain minimal access-controlled audit records for **90 days**; retain operational logs for **14–30 days** and expire backups on a documented schedule. Review old nonterminal deliveries separately. Avoid indefinite retention of identity mappings after account deletion. These are recommendations, not implemented jobs or configuration defaults.

Raw webhook bodies are processed in memory and are not persisted by the ingestion path. Stored event subsets and free text can still be sensitive; review before export. Tenant deletion cascades to its audit rows, while delivery deletion nulls audit delivery links, so preserve legally required evidence under a separate approved retention policy before deletion.

## Documentation

- [MCP tools](docs/mcp-tools.md)
- [Architecture and implementation limits](docs/architecture.md)
- [Security policy](SECURITY.md)
- [Threat model](THREAT_MODEL.md)
