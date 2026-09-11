# Chrome connection

Requires Windows, installed Chrome, Node.js 22+ and `npm install`. Close any Chrome instance already using this dedicated profile, then launch it **manually in PowerShell**:

```powershell
$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (!$chrome) { throw 'Chrome not found.' }
& $chrome --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 "--user-data-dir=$env:LOCALAPPDATA\doordash-mcp\chrome-profile" https://www.doordash.com/
```

Chrome requires a non-default profile for remote debugging. Log in/MFA directly in Chrome, keep a DoorDash tab open, then run from the repository:

```sh
npm run consumer:attach
npm run consumer:verify
```

Attach verifies the account and encrypts session state/account ID with Windows DPAPI. It detaches without closing Chrome. Tools use this live browser and account binding; standalone cookie replay is not established. Switching accounts requires explicit reattachment.

| Command | Meaning |
| --- | --- |
| `consumer:status` | Local snapshot decryptability/binding only; `account_verified=false` is not a live login verdict. |
| `consumer:verify` | Live account check. |
| `consumer:disconnect` | Remove snapshot; subsequent tools stop. Does not revoke DoorDash sessions or undo writes. |
| `consumer:reset-profile` | Remove dedicated Chrome profile **after closing Chrome**. Snapshot and placement records are separate. |

Files under `%LOCALAPPDATA%\doordash-mcp`: `consumer-session.dpapi` (encrypted snapshot), `chrome-profile/` (Chrome-managed data), `order-operations/` (encrypted duplicate-protection records). Keep operation records for reconciliation. Close Chrome to stop local CDP access; use DoorDash logout for session revocation.

Older `consumer:connect`/`consumer:open`/`consumer:persistent` automated launch experiments remain available but failed login challenges in live testing. They are not the supported tool connection flow; their SAVE action does not establish the verified account binding. Use manual launch + attach.

[MCP setup](../README.md) · [Agent tool guide](consumer-tools.md)
