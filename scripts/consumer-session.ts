import { createInterface } from 'node:readline/promises';
import { rm } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { deleteSession, loadSession, saveSession } from '../src/consumer/session-store.js';
import { persistentChromeOptions } from '../src/consumer/browser-profile.js';
import { captureChromeSession } from '../src/consumer/cdp-session.js';
import { ConsumerService } from '../src/consumer/service.js';
import { ConsumerError } from '../src/consumer/browser-client.js';

const command = process.argv[2];

async function main(): Promise<void> {
  if (command === 'verify') {
    try { console.log(JSON.stringify(await new ConsumerService().accountStatus(), null, 2)); }
    catch (error) {
      console.log(JSON.stringify({ account_verified: false, error: error instanceof ConsumerError ? error.code : 'INVALID_PROVIDER_RESPONSE' }));
      process.exitCode = 1;
    }
    return;
  }
  if (command === 'attach') {
    try {
      const session = await captureChromeSession();
      await saveSession(session.storage, undefined, session.accountId);
      console.log('DoorDash account verified and bound to the encrypted snapshot. CDP detached; Chrome remains open.');
    } catch {
      console.error('Could not capture Chrome session. Start Chrome with the documented loopback CDP command, sign in, and keep a DoorDash tab open. Existing encrypted snapshot was not intentionally cleared.');
      process.exitCode = 1;
    }
    return;
  }
  if (command === 'reset-profile') {
    await rm(persistentChromeOptions().userDataDir, { recursive: true, force: true });
    console.log('Dedicated Chrome profile removed. The encrypted snapshot is separate; use consumer:disconnect to remove it.');
    return;
  }
  if (command === 'disconnect') {
    await deleteSession();
    console.log('Saved consumer session removed. This does not revoke sessions on DoorDash or close other running browser commands.');
    return;
  }
  if (command === 'status') {
    const saved = await loadSession();
    console.log(JSON.stringify({
      session_saved: saved !== null,
      saved_at: saved?.savedAt ?? null,
      account_bound: !!saved?.accountId,
      account_verified: false,
      note: 'Local persistence status only. Run consumer:verify for a live account check.',
    }, null, 2));
    return;
  }
  if (command !== 'connect' && command !== 'open' && command !== 'persistent') {
    console.log('Usage: tsx scripts/consumer-session.ts connect|open|persistent|attach|reset-profile|status|verify|disconnect');
    return;
  }
  if (!process.stdin.isTTY) throw new Error('Run this command in an interactive terminal so you can confirm session saving.');
  const saved = command === 'open' ? await loadSession() : null;
  if (command === 'open' && !saved) throw new Error('No saved consumer session. Run consumer:connect first.');
  const persistent = command === 'persistent';
  const profile = persistent ? persistentChromeOptions() : null;
  if (persistent) {
    console.log('Using a dedicated persistent Chrome profile. Chrome retains profile data even without SAVE; this profile is not encrypted by our DPAPI snapshot mechanism.');
  }
  const browser = persistent ? null : await chromium.launch({ channel: 'chrome', headless: false });
  const context = profile
    ? await chromium.launchPersistentContext(profile.userDataDir, profile.options)
    : await browser!.newContext(saved ? { storageState: saved.storage } : {});
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto('https://www.doordash.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    console.log('Use Chrome to sign in to DoorDash and complete MFA. Do not enter passwords or codes in this terminal.');
    console.log('After you can access your account, return here. Saving captures DoorDash cookies/local storage; it does not yet verify account access.');
    const answer = await terminal.question(persistent
      ? 'Type SAVE to also create an encrypted snapshot, or Enter to close (Chrome profile is retained): '
      : 'Type SAVE to encrypt the current session, or press Enter to close without saving: ');
    if (answer.trim() === 'SAVE') {
      await saveSession(await context.storageState());
      console.log(persistent
        ? 'Snapshot encrypted. Run consumer:persistent to reopen this same Chrome profile.'
        : 'Session encrypted for this Windows user. Run consumer:open to test restoration in a new Chrome session.');
    }
  } finally {
    terminal.close();
    try { await context.close(); } finally { await browser?.close(); }
  }
}

main().catch(() => {
  console.error('Consumer session command failed. Ensure Chrome is installed, use an interactive terminal, and keep the browser open until saving finishes. No session details were logged.');
  process.exitCode = 1;
});
