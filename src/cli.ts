#!/usr/bin/env node
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { deleteSession, loadSession, saveSession, sessionPath } from './consumer/session-store.js';
import { ConsumerError } from './consumer/browser-client.js';

const help = `Usage: doordash-mcp [command]

  serve          Start the stdio MCP server (default)
  login-help     Print the manual Chrome launch instructions
  attach         Verify and save the signed-in Chrome session
  status         Inspect local saved-session metadata
  verify         Check the account with a live request
  disconnect     Delete the saved session (does not revoke DoorDash login)
  reset-profile  Delete the dedicated profile after closing Chrome
  --help         Show this help

Requires Windows and installed Chrome. CDP endpoint: http://127.0.0.1:9222.
Cart writes are enabled; place_order can charge a saved card.
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'serve';
  if (args.length > 1) throw new ConsumerError('INVALID_ARGUMENTS');
  switch (command) {
    case '--help':
    case '-h':
    case 'help':
      console.log(help);
      return;
    case 'login-help':
      console.log(`Run in PowerShell, then complete login/MFA in Chrome:

$chrome = @(
  "$env:ProgramFiles\\Google\\Chrome\\Application\\chrome.exe",
  "\${env:ProgramFiles(x86)}\\Google\\Chrome\\Application\\chrome.exe",
  "$env:LOCALAPPDATA\\Google\\Chrome\\Application\\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (!$chrome) { throw 'Chrome not found.' }
& $chrome --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 "--user-data-dir=$env:LOCALAPPDATA\\doordash-mcp\\chrome-profile" https://www.doordash.com/

Close any Chrome already using this dedicated profile before launching.
Keep a signed-in DoorDash tab open, then run:
  doordash-mcp attach
  doordash-mcp verify
`);
      return;
    case 'serve': {
      const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
      const { createConsumerMcpServer } = await import('./consumer/mcp.js');
      await createConsumerMcpServer().connect(new StdioServerTransport());
      return;
    }
    case 'attach': {
      const { captureChromeSession } = await import('./consumer/cdp-session.js');
      const session = await captureChromeSession();
      await saveSession(session.storage, undefined, session.accountId);
      console.log('Account verified and session encrypted. Chrome remains open.');
      return;
    }
    case 'status': {
      const saved = await loadSession();
      console.log(JSON.stringify({ session_saved: !!saved, saved_at: saved?.savedAt ?? null, account_bound: !!saved?.accountId,
        account_verified: false, note: 'Local metadata only. Run doordash-mcp verify for a live check.' }, null, 2));
      return;
    }
    case 'verify': {
      const { ConsumerService } = await import('./consumer/service.js');
      console.log(JSON.stringify(await new ConsumerService().accountStatus(), null, 2));
      return;
    }
    case 'disconnect':
      await deleteSession();
      console.log('Saved session removed. Browser login and order-operation records are retained.');
      return;
    case 'reset-profile':
      await rm(join(dirname(sessionPath()), 'chrome-profile'), { recursive: true, force: true });
      console.log('Dedicated Chrome profile removed. Saved snapshot and order-operation records are retained.');
      return;
    default:
      throw new ConsumerError('UNKNOWN_COMMAND');
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof ConsumerError ? error.code : 'COMMAND_FAILED');
  console.error('Run doordash-mcp --help for usage, or login-help for browser setup.');
  process.exitCode = 1;
});
