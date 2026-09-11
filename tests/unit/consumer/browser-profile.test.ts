import { join } from 'node:path';
import { expect, it } from 'vitest';
import { persistentChromeOptions } from '../../../src/consumer/browser-profile.js';

it('uses an app-specific profile and omits only the requested default argument', () => {
  const profile = persistentChromeOptions('local-app-data');
  expect(profile.userDataDir).toBe(join('local-app-data', 'doordash-mcp', 'chrome-profile'));
  expect(profile.options).toEqual({ channel: 'chrome', headless: false, ignoreDefaultArgs: ['--enable-automation'] });
});

it('fails before launch when the profile base is missing', () => {
  expect(() => persistentChromeOptions('')).toThrow('LOCALAPPDATA is required');
});
