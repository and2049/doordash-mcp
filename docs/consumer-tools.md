# Consumer tools: agent contract

**Runtime:** local Windows stdio, `doordash-mcp serve` (default). Keep manually launched CDP Chrome signed in with a DoorDash tab. `doordash-mcp attach` binds the account; `doordash-mcp verify` checks it live. [Setup](consumer-login.md).

## Tools

All results are JSON text. IDs are strings. Monetary `*_cents`/`unitAmount` are integer minor units; cart currency is `currencyCode`. Tool schemas specify defaults and bounds.

| Tool | Inputs / result |
| --- | --- |
| `get_consumer_account_status` | Live account ID/status/time. |
| `list_consumer_orders` | `offset=0`, `limit=10` (max 20); orders and `next_offset`. |
| `get_consumer_order_status` | `order_id`, `offset=0`; searches 20-order page, returns `found`/`next_offset`. |
| `get_order_payment_status` | `order_id`, `offset=0`; ownership checked in history page; returns provider `paid`, `paymentStatus`, `errorType`. |
| `search_restaurants` | `query`, `limit=20`; autocomplete matches at current browser delivery location. |
| `get_restaurant_menu` | `store_id`; default menu/category feed and loaded item IDs. |
| `get_menu_item_options` | `store_id`, `item_id`, `fulfillment_type=DELIVERY` or `PICKUP`; prices and group min/max constraints. |
| `list_carts` / `get_cart` | Open carts; `get_cart` requires `cart_id`. Null price fields mean unknown, not zero. |
| **`add_cart_item`** | `store_id`, `item_id`, `quantity=1`, optional `cart_id`, `options=[]`, `special_instructions=""`. Uses existing same-store cart or creates one; preserves other carts. |
| **`update_cart_item`** | `cart_id`, `cart_item_id`, `quantity` (1–99), optional instructions. Sets quantity; preserves selected options. |
| **`remove_cart_item`** | `cart_id`, `cart_item_id`; removes the entire line. |
| **`clear_cart`** | `cart_id`; deletes that open cart, not a submitted order. |
| `get_checkout_preview` | `cart_id`, `tip_cents=0`; returns priced cart/line items, selected payment-card ID, `total_cents`, `preview_hash`. Does not submit or persist the requested tip. |
| **`place_order`** | `cart_id`, UUID `request_id`, exact `preview_hash`, `total_cents`, same `tip_cents`, selected numeric `payment_card_id`. **Real purchase; mock-tested only.** |
| `get_order_operation` | `cart_id`; durable submission state; known order UUIDs also get a live payment check. |

Bold tools mutate the account. `get_checkout_preview` reads the provider's checkout query. No tool automatically retries mutations.

## Cart workflow

1. Verify account; search → menu → item options. Use provider IDs, never guess them.
2. Inspect existing carts before editing. `item_id` is a **menu item**; `cart_item_id` is an **added cart line**.
3. Add with selections such as `[{"id":"OPTION_ID","quantity":1,"options":[{"id":"NESTED_OPTION_ID","quantity":1}]}]`. Respect each group's min/max constraints. One nested level is supported. Server supplies names/prices from the live item query.
4. Inspect returned cart. Update quantity/instructions with the cart-line ID. To change selections, remove that line and re-add it.
5. Preview checkout with the intended tip. It uses provider `total`, replacing an existing `tipAmount` when present; it does not sum incomplete legacy fee fields. Null fee details remain null; priced `lineItemsList` is the useful breakdown.

## Purchase and recovery

- Only invoke `place_order` when the user has requested the actual purchase. **Current live testing excludes this tool.** Do not infer purchase authority from cart-test permission.
- Use a fresh preview's exact hash/total, the same tip, and its selected saved-card ID. Generate one UUID request ID and keep it with the cart. Select destination/payment in Chrome beforehand; the tool does not add cards or change address. Numeric saved-card checkout only; unsupported payment paths return `SELECT_PAYMENT_IN_BROWSER`.
- Preview changes → `CHECKOUT_CHANGED`: inspect a new preview before attempting placement. No request was submitted by that failed preflight.
- `submitted` means the provider returned an order UUID, **not that payment succeeded**. Call `get_order_operation` for payment status.
- `pending`/`unknown`, timeout, or `MUTATION_OUTCOME_UNKNOWN` may mean the write succeeded. Inspect cart/history/operation state. **Never blindly repeat an add or submit with a new request ID.**
- A durable claim permits only one placement attempt per account/cart, including after restart. Repeating identical placement arguments returns the saved state. Different arguments produce a conflict. Do not delete journal files to force a retry.
- No automatic resolution of unknown purchases: compare browser order history first. If a UUID was recorded, the status tool can poll payment. Never equate “not found in one history page” with “not placed.”

## Limits and verification

- Orders: lifecycle timestamps only (`cancelled`, `fulfilled`, `submitted`, `unknown`); courier/ETA tracking unverified. Follow `next_offset` for older orders. Provider limit50 returned an empty list; cap20 is intentional.
- Search: non-exhaustive autocomplete. Menu feed can be partial; no category continuation or alternate menu/schedule selection. Customization beyond one nested level is unavailable.
- Carts: individual open carts only. Placement supports basic ASAP saved-card checkout; group, alcohol, shipping, prescription, bundle, catering, merchant-tip/self-delivery paths are unsupported. New-card entry, saved-address changes, promotions, subscriptions and order cancellation are not exposed.
- `BROWSER_UNAVAILABLE`/reauthentication: reopen manual CDP Chrome, sign in; reattach only to intentionally bind the account. Direct cookie-only requests encountered Cloudflare 403.
- Live verified: original six reads, cart listing/view/add/update/remove/delete, checkout preview, empty operation lookup and payment status of an existing order. Option-bearing add/update also verified. **Placement and post-placement operation/payment reconciliation are mock-tested only.**

Live smoke commands: `consumer:test-reads` and `consumer:test-cart` (optional `-- --options`), after `npm run build`. Cart smoke modifies a small test cart and cleans up; its allowlist excludes placement. Normal `npm test` is offline.
