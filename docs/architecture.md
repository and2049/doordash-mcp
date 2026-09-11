# Consumer architecture

`src/cli.ts` is the package executable (`dist/cli.js`). Its default `serve` command starts stdio MCP; other commands manage the session or print manual login instructions. `src/consumer/` contains the consumer implementation. Runtime dependencies are the MCP SDK, Playwright Core and Zod.

| File in `src/consumer/` | Responsibility |
| --- | --- |
| `mcp.ts` | Tool schemas, read/write annotations, sanitized results; serializes mutations within each MCP server instance. |
| `service.ts` | Account/order/search/menu projections. |
| `cart-service.ts` | Owned open-cart lookup, add/update/remove, option constraints, priced checkout preview/hash. |
| `ordering-service.ts` | Preview comparison, one-shot placement, operation/payment status. |
| `order-operations.ts` | DPAPI-encrypted per-account/cart journal; exclusive synced claim, atomic result replacement. |
| `browser-client.ts` | Loopback CDP connection, account checks, bounded fixed requests, ambiguous-write errors, detach. |
| `queries.ts` | Allowlisted GraphQL reads/mutations. |
| `session-store.ts`, `cdp-session.ts` | Secure snapshot lifecycle and verified account binding. |

Placement flow: live account → existing journal lookup → refreshed preview match → exclusive durable pending claim → one provider submission → submitted/unknown record. A crash leaves a blocking pending record. Known UUIDs can be payment-checked; unknown outcomes require browser/history reconciliation and never auto-resubmit.

Mutations in different MCP processes or the browser can still race; the durable claim specifically prevents duplicate server placement for one cart. The provider is authoritative for availability, final pricing and charge outcome.

Package flow: `npm pack` → clean TypeScript build → allowlisted compiled JS/docs. No install-time scripts or browser download. Persistent data lives outside the package under the Windows user profile. Source tests and live smoke scripts are not shipped.

Contracts: [consumer-tools.md](consumer-tools.md). Setup: [README](../README.md).
