# doordash-mcp

16 consumer MCP tools for account/orders, restaurants/menus, cart edits, checkout previews and ordering. **Windows + Node.js 22+ + installed Chrome required.** Login uses your manually launched browser; session and operation records are encrypted with Windows DPAPI.

`place_order` can charge a saved card. It is mock-tested only; the other workflows have live verification. [Agent tool contract](docs/consumer-tools.md).

## Install

The examples below target **0.1.1** and require that version to be published. Run without a global install:

```sh
npx -y doordash-mcp@0.1.1 login-help
```

Or install globally with `npm install --global doordash-mcp@0.1.1`. The package contains compiled JavaScript, agent docs and the MIT license; it requires no TypeScript tooling or browser download.

Releases are published from CI: pushing a `v`-prefixed tag (e.g. `v0.1.1`) runs the publish workflow, which lints, typechecks, tests, builds and publishes to npm with provenance. See [Publishing](docs/publishing.md). To install from a [source checkout](https://github.com/and2049/doordash-mcp) instead:

```sh
npm ci
npm pack
npm install --global ./doordash-mcp-0.1.1.tgz
```

## Connect

```sh
doordash-mcp login-help
```

The commands in this section assume a global or local-tarball installation; otherwise replace `doordash-mcp` with `npx -y doordash-mcp@0.1.1`. Run the printed PowerShell command yourself, then sign in/MFA in Chrome. Keep its DoorDash tab open:

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

### redsun

Merge into `~/.config/redsun/redsun.jsonc` (global) or the project's `redsun.jsonc`. redsun uses `mcp.servers`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "doordash": {
        "type": "local",
        "command": ["npx", "-y", "doordash-mcp@0.1.1", "serve"],
        "timeout": { "startup": 60000 }
      }
    }
  }
}
```

This downloads the pinned release as needed; no global install is required. Browser login/attach is still required. Existing encrypted state survives package upgrades. Use `redsun mcp list` to check connection status.

## Development / release

`npm run dev` starts stdio from source; `npm start` uses the build. `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` are offline checks. Build cleans old output. `npm pack` rebuilds and uses an explicit package-file allowlist.

Live source-checkout smoke tests: `npm run consumer:test-reads`; `npm run consumer:test-cart` (optional `-- --options`) **edits a small test cart and cleans up**. Placement is excluded from the test allowlist. Rebuild first.

See [Publishing](docs/publishing.md) for the tag-based release process. Nothing publishes during install/build/tests.

[Tools](docs/consumer-tools.md) · [Architecture](docs/architecture.md) · [Security](SECURITY.md) · [MIT License](LICENSE)
