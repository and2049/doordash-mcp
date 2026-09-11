import { join } from 'node:path';

export function persistentChromeOptions(localAppData = process.env.LOCALAPPDATA): {
  userDataDir: string;
  options: { channel: string; headless: boolean; ignoreDefaultArgs: string[] };
} {
  if (!localAppData) throw new Error('LOCALAPPDATA is required for the dedicated Chrome profile.');
  return {
    userDataDir: join(localAppData, 'doordash-mcp', 'chrome-profile'),
    options: { channel: 'chrome', headless: false, ignoreDefaultArgs: ['--enable-automation'] },
  };
}
