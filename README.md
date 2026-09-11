# doordash-mcp

16 consumer MCP tools for account/orders, restaurants/menus, cart edits, checkout previews and ordering. **Windows + Node.js 22+ + installed Chrome required.** Login uses your manually launched browser; session and operation records are encrypted with Windows DPAPI.

`place_order` can charge a saved card. It is mock-tested only; the other workflows have live verification. [Agent tool contract](docs/consumer-tools.md).

## Install

The npm package is prepared but **not published to the registry yet**. From a checkout of [this repository](https://github.com/and2049/doordash-mcp), build and install a local package today:

```sh
npm ci
npm pack
npm install --global ./doordash-mcp-0.1.0.tgz
```

The tarball contains compiled JavaScript and agent docs; installing it requires no TypeScript tooling or browser download. After registry publication, installation becomes `npm install --global doordash-mcp@0.1.0`.

## Connect

```sh
doordash-mcp login-help
```

Run the printed PowerShell command yourself, then sign in/MFA in Chrome. Keep its DoorDash tab open:

```sh
doordash-mcp attach
doordash-mcp verify
```

Configure your MCP client:

```json
{
  "mcpServers": {
    "doordash": {
      "command": "doordash-mcp",
      "args": ["serve"]
    }
  }
}
```

Ensure npm's global bin directory is on the client's PATH. Windows clients may require `doordash-mcp.cmd`. If a client cannot launch command shims, use `node` with the absolute installed path `<npm root -g>/doordash-mcp/dist/cli.js` and `serve`. From a source checkout, use `<checkout>/dist/cli.js` instead.

`serve` is the default command and writes only MCP protocol output to stdout. Session commands: `status`, `verify`, `attach`, `disconnect`, `reset-profile`; see [login/storage](docs/consumer-login.md). There is no HTTP server or database to configure.

## Development / release

`npm run dev` starts stdio from source; `npm start` uses the build. `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` are offline checks. Build cleans old output. `npm pack` rebuilds and uses an explicit package-file allowlist.

Live source-checkout smoke tests: `npm run consumer:test-reads`; `npm run consumer:test-cart` (optional `-- --options`) **edits a small test cart and cleans up**. Placement is excluded from the test allowlist. Rebuild first.

For a registry release: choose the package name/version and distribution license (currently `UNLICENSED`), inspect `npm pack --dry-run`, then publish explicitly with your npm account. Nothing publishes during install/build/tests.

[Tools](docs/consumer-tools.md) · [Architecture](docs/architecture.md) · [Security](SECURITY.md)
