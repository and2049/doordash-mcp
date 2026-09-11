# DoorDash consumer MCP

Local Windows + Chrome MCP server for account/order reads, restaurant menus, cart edits and checkout previews. `place_order` is implemented with durable duplicate protection but **has not been live-tested**. Other tools have live verification; see [tool guide](docs/consumer-tools.md).

## Start

Requires Node.js 22+, installed Chrome and Windows PowerShell/DPAPI.

```sh
npm install
npm run build
```

1. [Launch Chrome manually and sign in](docs/consumer-login.md).
2. Run `npm run consumer:attach`, then `npm run consumer:verify`.
3. Keep that Chrome instance open. Configure your MCP client:

```json
{
  "mcpServers": {
    "doordash-consumer": {
      "command": "node",
      "args": ["C:/path/to/dd-mcp/dist/consumer/index.js"]
    }
  }
}
```

Use your absolute checkout path. No Drive credentials, database, Docker or HTTP OAuth setup is needed. `npm run consumer:mcp` is the development entry point.

## Agent workflow

`get_consumer_account_status` → `search_restaurants` → `get_restaurant_menu` → `get_menu_item_options` → `add_cart_item` → `get_cart` → `get_checkout_preview`.

Read [tool contracts and purchase/recovery rules](docs/consumer-tools.md) before making writes. Cart-line IDs differ from menu-item IDs. An ambiguous mutation is not a failed mutation; inspect state before acting again.

## Checks

- `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`: local checks, no real orders.
- `npm run consumer:test-reads`: six read tools against the connected account.
- `npm run consumer:test-cart` (optional `-- --options`): **live cart edits**, inexpensive test item, cleanup afterward. Its allowlist excludes placement.

Rebuild before MCP smoke tests. [Security](SECURITY.md) · [Architecture](docs/architecture.md) · [Legacy Drive server](LEGACY_DRIVE.md).
