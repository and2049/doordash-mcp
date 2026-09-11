# Publish to npm

Release metadata: `doordash-mcp@0.1.1`, MIT, Windows-only, Node.js 22+. The executable is `doordash-mcp`. Publishing is a manual maintainer action.

## Authenticate

Use your own terminal. Verify the npm account email and enable publishing 2FA, then:

```sh
npm login --auth-type=web --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
```

`whoami` must print your username. If it returns E401, fix authentication before publishing. A publish E404 can indicate access/authentication problems, not just an unavailable name. Never paste tokens or `.npmrc` credentials into logs or chat.

## Pack and publish

From the source checkout:

```sh
npm ci
npm test
npm run typecheck
npm run lint
npm pack
```

`prepack` performs a clean build. Review the printed file list: compiled JS, README, LICENSE and docs only. Publish the newly built artifact, not an older tarball:

```sh
npm publish ./doordash-mcp-0.1.1.tgz --access public --registry=https://registry.npmjs.org/
npm view doordash-mcp@0.1.1 version license --registry=https://registry.npmjs.org/
npx -y doordash-mcp@0.1.1 --help
```

Complete npm's authentication/2FA prompt. Update README release availability after successful publication. [redsun configuration](../README.md#redsun) launches the pinned package through npx.

## Later releases

Update the version consistently in `package.json`, `package-lock.json`, MCP server metadata in `src/consumer/mcp.ts`, and pinned documentation examples. Repeat checks/pack/publish. An already-published name/version cannot be overwritten; a failed attempt alone does not require a version bump.
