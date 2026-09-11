# Publish to npm

Release metadata: `doordash-mcp@0.1.3`, MIT, Windows-only, Node.js 22+. The 0.1.2 release failed because its npm CLI lacked trusted-publishing support; 0.1.3 contains the workflow fix. The executable is `doordash-mcp`. Releases are published by CI ([`.github/workflows/publish.yml`](../.github/workflows/publish.yml)) when a `v`-prefixed tag is pushed.

## Trusted publishing

The workflow explicitly installs npm11.10.1: trusted publishing requires npm11.5.1+ and Node22.14.0+. Node22's bundled npm10 cannot authenticate through OIDC, even though it can sign provenance. Keep the npm upgrade before publishing. An explicit build before publish also ensures the CLI exists when npm first validates package metadata.

The npm package is configured for trusted publishing (OIDC) against this repository and workflow, so no npm token is stored in GitHub. The workflow publishes with `--provenance --access public`; npm's 2FA prompt does not apply to OIDC publishing.

## Release by tag

1. Update the version consistently in `package.json`, `package-lock.json`, MCP server metadata in `src/consumer/mcp.ts`, and pinned documentation examples.
2. Commit, then create and push the tag — it must match `v` + `package.json` version or the workflow fails:

```sh
git tag v0.1.3
git push origin v0.1.3
```

The workflow installs dependencies (`npm ci`), runs `lint`, `typecheck` and `test`, verifies the tag matches the package version, then publishes. `prepack` performs a clean build, so the published tarball contains freshly compiled JS, README, LICENSE and docs only.

3. Verify the release:

```sh
npm view doordash-mcp@0.1.3 version license --registry=https://registry.npmjs.org/
npx -y doordash-mcp@0.1.3 --help
```

An already-published name/version cannot be overwritten; a failed attempt alone does not require a version bump.

## Local verification

The offline checks can still be run from a source checkout before tagging:

```sh
npm ci
npm test
npm run typecheck
npm run lint
npm pack
```

Never paste tokens or `.npmrc` credentials into logs or chat. Update README release availability after successful publication. [redsun configuration](../README.md#redsun) launches the pinned package through npx.
