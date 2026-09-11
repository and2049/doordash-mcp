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
| `get_checkout_preview` | `cart_id`, `tip_cents=0`, optional boolean `apply_credits`; returns priced cart/line items, selected payment-card ID, credits selection/available balance, `total_cents`, `preview_hash`. Does not submit or persist the requested tip. |
| **`place_order`** | `cart_id`, UUID `request_id`, exact `preview_hash`, `total_cents`, same `tip_cents` and `apply_credits` choice, selected numeric `payment_card_id` (zero-due credits exception below). **Real purchase.** |
| `get_order_operation` | `cart_id`; reads the saved account's local journal without Chrome. Known UUIDs get best-effort live payment polling. Poll errors return `payment_error` alongside the preserved record. Not live account verification. |

Bold tools mutate the account. `get_checkout_preview` reads the provider's checkout query. No tool automatically retries mutations.

## Cart workflow

1. Verify account; search → menu → item options. Use provider IDs, never guess them.
2. Inspect existing carts before editing. `item_id` is a **menu item**; `cart_item_id` is an **added cart line**.
3. Add with selections such as `[{"id":"OPTION_ID","quantity":1,"options":[{"id":"NESTED_OPTION_ID","quantity":1}]}]`. Respect each group's min/max constraints. One nested level is supported. Server supplies names/prices from the live item query.
4. Inspect returned cart. Update quantity/instructions with the cart-line ID. To change selections, remove that line and re-add it.
   Fulfillment workflow: create the cart, then select the user's requested pickup/delivery mode before previewing. A dedicated cart-fulfillment tool is not implemented yet; use Chrome for that step and reread the cart to verify `isConsumerPickup`. Do not assume a new cart matches the requested mode.
5. Preview checkout with the intended tip. It uses provider `total`, replacing an existing `tipAmount` when present; it does not sum incomplete legacy fee fields. Null fee details remain null; priced `lineItemsList` is the useful breakdown.

## Purchase and recovery

### Credits

Set `apply_credits: true` to request available DoorDash credits, or `false` to disable them, on `get_checkout_preview`. Pass the same value to `place_order`. Omitting it on both preserves provider-default behavior. Changing between true, false or omitted requires a new preview even if the price is unchanged.

Preview returns `apply_credits` (requested choice, null if omitted), `credits_selected` (provider confirmation, null if unavailable), and `credits_available` (provider money object or null). Explicit choices fail with `CREDITS_SELECTION_NOT_CONFIRMED` if the provider does not echo the requested boolean. Inspect checkout in Chrome before proceeding. These fields do not prove credits have been spent; available balance is not the applied amount and can return zero when credits are disabled.

The server passes `shouldApplyCredits` to both provider operations and includes the choice in preview/durable submission checks. Provider total and line items remain authoritative; it never subtracts the available balance itself. The existing explicit-tip adjustment is unchanged. `payment_card_id` may be omitted only when credits are explicitly enabled and confirmed, both provider and preview totals are zero, and the requested tip is zero. Otherwise a selected numeric saved-card ID is required.

Credits on/off previews were live-verified against Chrome for a pickup cart. One credit-covered pickup submission was confirmed placed by the user, but the tool returned unknown without an order UUID and subsequent CDP reads failed. Payment polling, credit settlement and fallback-card charges were not independently verified. Preserve the unknown journal record and do not retry.

- Only invoke `place_order` when the user has requested the actual purchase. Automated live smoke tests exclude this tool. Do not infer purchase authority from cart-test permission.
- Use a fresh preview's exact hash/total, the same tip and credits choice, and its selected saved-card ID (or the zero-due credits exception above). Generate one UUID request ID and keep it with the cart. Select destination/payment in Chrome beforehand; the tool does not add cards or change address. Unsupported payment paths return `SELECT_PAYMENT_IN_BROWSER`.
- Invoke `place_order` **once per intended purchase**. After every result, including errors/timeouts, switch to `get_order_operation` and `list_consumer_orders` rather than invoking placement again.
- Compare order history by submission time, restaurant, items/quantities and pickup/delivery; use the exact UUID if returned. Amounts may differ in presentation due to credits. A similar historical order is only a candidate, not proof. Follow `next_offset` as needed. Absence from history is not proof of failure or permission to retry.
- If reads fail or matching is ambiguous, ask the user to check DoorDash's Orders page. Report user confirmation separately from API/payment verification. Do not recreate the cart or remove/change the journal to bypass duplicate protection.
- Preview changes → `CHECKOUT_CHANGED`: no request was submitted by that failed preflight. Inspect the record/history, obtain a new preview and renewed purchase instruction rather than automatically resubmitting.
- `submitted` means the provider returned an order UUID, **not that payment succeeded**. `get_order_operation` retains that UUID even if its payment poll fails; inspect `payment_verified`, `payment` or `payment_error`. A record with source `local_operation_journal` reflects the saved account binding, not a live account check.
- `pending`/`unknown`, timeout, or `MUTATION_OUTCOME_UNKNOWN` may mean the write succeeded. **Never blindly repeat an add or submit with a new request ID.**
- A durable claim permits only one placement attempt per account/cart, including after restart. Repeating identical placement arguments returns the saved state. Different arguments produce a conflict. Do not delete journal files to force a retry.
- No automatic resolution of unknown purchases: compare browser order history first. If a UUID was recorded, the status tool can poll payment. Never equate “not found in one history page” with “not placed.”

## Limits and verification

- Orders: lifecycle timestamps only (`cancelled`, `fulfilled`, `submitted`, `unknown`); courier/ETA tracking unverified. Follow `next_offset` for older orders. Provider limit50 returned an empty list; cap20 is intentional.
- Search: non-exhaustive autocomplete. Menu feed can be partial; no category continuation or alternate menu/schedule selection. Customization beyond one nested level is unavailable.
- Carts: individual open carts only. Placement supports basic ASAP saved-card checkout; group, alcohol, shipping, prescription, bundle, catering, merchant-tip/self-delivery paths are unsupported. New-card entry, saved-address changes, promotions, subscriptions and order cancellation are not exposed.
- `BROWSER_UNAVAILABLE`/reauthentication: reopen manual CDP Chrome, sign in; reattach only to intentionally bind the account. Direct cookie-only requests encountered Cloudflare 403.
- Live verified: original six reads, cart listing/view/add/update/remove/delete, checkout preview including credits on/off, empty operation lookup and payment status of an existing order. Option-bearing add/update also verified. One credit-covered pickup placement was user-confirmed successful, but returned unknown with no order UUID. Successful automated post-placement reconciliation and card charging remain unverified.

Live smoke commands: `consumer:test-reads` and `consumer:test-cart` (optional `-- --options`), after `npm run build`. Cart smoke modifies a small test cart and cleans up; its allowlist excludes placement. Normal `npm test` is offline.
