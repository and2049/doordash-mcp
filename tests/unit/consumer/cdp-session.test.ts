import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { expect, it } from 'vitest';
import { readDoorDashSession } from '../../../src/consumer/cdp-session.js';

const hasChrome = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
  .some((base) => base && existsSync(join(base, 'Google', 'Chrome', 'Application', 'chrome.exe')));

it.skipIf(!hasChrome)('captures only DoorDash state without navigating or closing user pages', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext();
    await context.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
    await context.addCookies([
      { name: 'session', value: 'fake-session', domain: '.doordash.com', path: '/', secure: true },
      { name: 'unrelated', value: 'exclude-me', domain: '.example.com', path: '/' },
    ]);
    const page = await context.newPage();
    await page.goto('https://www.doordash.com/');
    await page.evaluate(() => localStorage.setItem('sample', 'fake-storage'));
    const unrelated = await context.newPage();
    await unrelated.goto('https://example.com/');
    await unrelated.evaluate(() => localStorage.setItem('unrelated', 'exclude-me'));
    const session = await readDoorDashSession(context);
    expect(session.storage.cookies.map(({ name }) => name)).toEqual(['session']);
    expect(session.storage.origins).toEqual([{ origin: 'https://www.doordash.com', localStorage: [{ name: 'sample', value: 'fake-storage' }] }]);
    expect(page.url()).toBe('https://www.doordash.com/');
    expect(context.pages()).toHaveLength(2);
    expect(JSON.stringify(session)).not.toContain('exclude-me');
  } finally {
    await browser.close();
  }
}, 30_000);
