import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { expect, it, vi } from 'vitest';
import { consumerRequest } from '../../../src/consumer/browser-client.js';
import { loadSession } from '../../../src/consumer/session-store.js';

vi.mock('../../../src/consumer/session-store.js', () => ({ loadSession: vi.fn() }));

const hasChrome = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
  .some((base) => base && existsSync(join(base, 'Google', 'Chrome', 'Application', 'chrome.exe')));

it.skipIf(!hasChrome)('enforces account binding, disconnect, HTTP errors and read-only browser requests', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const close = browser.close.bind(browser);
  const context = await browser.newContext();
  const saved = { version: 1 as const, savedAt: '2026-09-11T00:00:00.000Z', accountId: 'account-a', storage: { cookies: [], origins: [] } };
  vi.mocked(loadSession).mockResolvedValue(saved);
  vi.spyOn(chromium, 'connectOverCDP').mockResolvedValue(browser);
  vi.spyOn(browser, 'close').mockResolvedValue();
  let accountId = 'account-a';
  let status = 200;
  let queryCount = 0;
  let mutationCount = 0;
  let switchDuringQuery = false;
  await context.route('**/*', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/unified-gateway/contributor/v1/consumer_details') {
      await route.fulfill({ status, json: { consumer_id: accountId, profile_status: 'active' } });
    } else if (path === '/graphql/getConsumerOrdersWithDetails') {
      queryCount++;
      const body = route.request().postDataJSON() as { query: string };
      expect(body.query.trim().startsWith('query ')).toBe(true);
      expect(body.query).not.toContain('mutation');
      if (switchDuringQuery) accountId = 'account-b';
      await route.fulfill({ json: { data: { getConsumerOrdersWithDetails: [] } } });
    } else if (path === '/graphql/addCartItem') {
      mutationCount++;
      await route.abort();
    } else await route.fulfill({ contentType: 'text/html', body: '<html></html>' });
  });
  const page = await context.newPage();
  await page.goto('https://www.doordash.com/home');
  try {
    expect(await consumerRequest('account')).toMatchObject({ consumer_id: 'account-a' });
    expect(await consumerRequest('getConsumerOrdersWithDetails', { offset: 0, limit: 10 })).toMatchObject({ data: { getConsumerOrdersWithDetails: [] } });
    accountId = 'account-b';
    await expect(consumerRequest('getConsumerOrdersWithDetails')).rejects.toThrow('ACCOUNT_MISMATCH');
    expect(queryCount).toBe(1);
    accountId = 'account-a';
    switchDuringQuery = true;
    await expect(consumerRequest('getConsumerOrdersWithDetails')).rejects.toThrow('ACCOUNT_MISMATCH');
    switchDuringQuery = false;
    accountId = 'account-a';
    status = 403;
    await expect(consumerRequest('account')).rejects.toThrow('REAUTHENTICATION_REQUIRED');
    status = 429;
    await expect(consumerRequest('account')).rejects.toThrow('RATE_LIMITED');
    status = 200;
    vi.mocked(loadSession).mockResolvedValueOnce(saved).mockResolvedValueOnce(null);
    await expect(consumerRequest('account')).rejects.toThrow('SESSION_CHANGED_REATTACH');
    vi.mocked(loadSession).mockResolvedValue(null);
    await expect(consumerRequest('account')).rejects.toThrow('SESSION_NOT_SAVED');
    vi.mocked(loadSession).mockResolvedValue(saved);
    await expect(consumerRequest('addCartItem')).rejects.toThrow('MUTATION_OUTCOME_UNKNOWN');
    expect(mutationCount).toBe(1);
    await expect(consumerRequest('addCartItem', {}, 'different-account')).rejects.toThrow('ACCOUNT_MISMATCH');
    expect(mutationCount).toBe(1);
    expect(page.isClosed()).toBe(false);
    expect(page.url()).toBe('https://www.doordash.com/home');
  } finally {
    vi.restoreAllMocks();
    await close();
  }
}, 30_000);
