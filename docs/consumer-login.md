# Browser login and storage

After installing the package, run `doordash-mcp login-help`. It prints a manual PowerShell launch command using installed Chrome, a dedicated profile, and loopback CDP port 9222. Close any Chrome already using that profile, run the command yourself, and finish login/MFA in Chrome.

Without a global install, use `npx -y doordash-mcp@0.1.3 <command>` for each CLI command. For example, `npx -y doordash-mcp@0.1.3 attach`. This uses the same saved account/profile as a global or source installation.

Then run `doordash-mcp attach` and `doordash-mcp verify`. Attach verifies the account, encrypts its binding/session, and detaches without closing Chrome. Keep a signed-in DoorDash tab open while agents use the tools. No automated login or browser download is performed.

| CLI command | Meaning |
| --- | --- |
| `login-help` | Print the Chrome launch command; does not launch or attach. |
| `attach` | Verify and save the currently signed-in account. Required after intentionally switching accounts. |
| `status` | Local snapshot metadata only; `account_verified=false` is not a live login verdict. |
| `verify` | Live account check; fails if Chrome is unavailable or the account differs from the binding. |
| `disconnect` | Remove snapshot; subsequent tools stop. Does not revoke browser login or undo writes. |
| `reset-profile` | Remove dedicated Chrome profile after closing Chrome; snapshot/journal are separate. |

Data is independent of the install location and survives npm upgrades under `%LOCALAPPDATA%\doordash-mcp`:

- `consumer-session.dpapi`: DPAPI-encrypted session and verified account ID.
- `chrome-profile/`: Chrome-managed persistent browser data; not all stores are encrypted.
- `order-operations/`: encrypted duplicate-protection records. Retain for reconciliation; deleting them removes protection.

Modern Chrome requires a non-default profile for remote debugging. Keep CDP loopback-only; local programs with access to it can control that profile. Close Chrome to stop CDP, and log out through DoorDash to revoke sessions. Cookie-only requests encountered Cloudflare 403; tools use the live browser.

From source, the same CLI is `node dist/cli.js <command>` after building. `npm run consumer:attach`, `consumer:verify`, and other supported session aliases remain available for development.
