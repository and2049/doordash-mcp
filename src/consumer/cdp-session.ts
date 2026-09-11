import { chromium } from 'playwright-core';
import type { BrowserContext } from 'playwright-core';
import { prepareSession } from './session-store.js';
import type { ConsumerSession } from './session-store.js';

export async function readDoorDashSession(context: BrowserContext): Promise<ConsumerSession> {
  const cookies = await context.cookies(['https://www.doordash.com/', 'https://identity.doordash.com/']);
  const origins = new Map<string, { origin: string; localStorage: { name: string; value: string }[] }>();
  for (const page of context.pages()) {
    const url = new URL(page.url());
    if (url.protocol !== 'https:' || !(url.hostname === 'doordash.com' || url.hostname.endsWith('.doordash.com'))) continue;
    const state = await page.evaluate((expectedOrigin) => {
      const origin = (globalThis as unknown as { location: { origin: string } }).location.origin;
      if (origin !== expectedOrigin) return null;
      return { origin, localStorage: Object.entries(localStorage).map(([name, value]) => ({ name, value })) };
    }, url.origin);
    if (state) origins.set(state.origin, state);
  }
  return prepareSession({ cookies, origins: [...origins.values()] });
}

export async function captureChromeSession(): Promise<ConsumerSession> {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222', { timeout: 15_000 });
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error('Chrome has no browser context.');
    const session = await readDoorDashSession(context);
    if (session.storage.cookies.length === 0) throw new Error('No DoorDash cookies found.');
    const page = context.pages().find((page) => new URL(page.url()).origin === 'https://www.doordash.com');
    if (!page) throw new Error('DoorDash tab required.');
    const accountId = await page.evaluate(async () => {
      if ((globalThis as unknown as { location: { origin: string } }).location.origin !== 'https://www.doordash.com') return null;
      const response = await fetch('/unified-gateway/contributor/v1/consumer_details', { credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(20_000) });
      if (!response.ok) return null;
      const account = await response.json() as unknown;
      return account && typeof account === 'object' && 'consumer_id' in account && typeof account.consumer_id === 'string' ? account.consumer_id : null;
    });
    if (!accountId) throw new Error('Account verification failed.');
    return { ...session, accountId };
  } finally {
    await browser.close();
  }
}
