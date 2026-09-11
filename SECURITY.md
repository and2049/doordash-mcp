# Consumer security

- **Boundary:** single Windows user, local stdio MCP, manually launched Chrome at `127.0.0.1:9222`. This is not a hosted multi-user service. Local programs with CDP access can control the browser profile.
- **Secrets:** session state, account binding and placement records use Windows DPAPI CurrentUser under `%LOCALAPPDATA%\doordash-mcp`. Plaintext is passed to PowerShell over stdin, never command arguments or plaintext export files. Chrome's separate persistent profile is Chrome-managed; not every store is encrypted.
- **Account binding:** each request checks the live account against the encrypted binding; non-account requests recheck identity and snapshot before returning. An account switch during a mutation may still affect the provider; the result is then unknown, not safely retryable.
- **Local recovery:** `get_order_operation` reads only the saved account's encrypted journal without requiring Chrome. It rechecks the snapshot before returning; this is not live account verification. Known order IDs get best-effort account-bound payment polling; poll failures preserve local state without asserting payment success.
- **Tools:** fixed operations and typed inputs; no arbitrary fetch/GraphQL tool. Cart edits and real order placement are enabled. Provider output is projected to requested fields; payment output is limited to identifiers/status, never PAN/CVC, client secrets or tokens. Do not log headers, raw exceptions, browser state or traffic dumps.
- **Purchases:** placement records are written exclusively and synced before dispatch. One attempt per account/cart, even across process restart. Errors after dispatch become unknown; there is no automatic retry. This is local duplicate suppression, not provider-guaranteed exactly-once delivery. Keep records for reconciliation; deleting them removes duplicate protection.
- **Disconnect:** deleting the snapshot prevents subsequent calls. Close Chrome separately to stop CDP access and log out at DoorDash to revoke provider sessions. Disconnect does not undo completed/in-flight writes or remove placement records.

The npm package includes only compiled JavaScript and documentation. It contains no profile/snapshot/journal, fixture credentials, tests, `.env`, or install-time browser download. Package uninstall does not delete user data.

Report vulnerabilities privately to maintainers via the hosting platform when available. Include sanitized reproduction steps and revision; never include sessions or personal order data. [Threat model](THREAT_MODEL.md).
