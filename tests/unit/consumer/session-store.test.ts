import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deleteSession, loadSession, prepareSession, protectSession, saveSession } from '../../../src/consumer/session-store.js';

const storage = {
  cookies: [{ name: 'session', value: 'test-secret-session', domain: '.doordash.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }],
  origins: [{ origin: 'https://www.doordash.com', localStorage: [{ name: 'test', value: 'test-secret-storage' }] }],
};

describe('consumer session storage', () => {
  it('retains only DoorDash cookies and HTTPS origins', () => {
    const result = prepareSession({
      cookies: [...storage.cookies, { ...storage.cookies[0], domain: 'doordash.com.attacker.test' }],
      origins: [...storage.origins, { origin: 'http://www.doordash.com', localStorage: [] }, { origin: 'https://example.com', localStorage: [] }],
    });
    expect(result.storage).toEqual(storage);
  });

  it.skipIf(process.platform !== 'win32')('persists encrypted data, replaces it, restores it and disconnects', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dd-session-test-'));
    const path = join(directory, 'nested', 'session.dpapi');
    try {
      expect(await loadSession(path)).toBeNull();
      await saveSession(storage, path, 'test-account-id');
      const disk = await readFile(path);
      expect(disk.includes(Buffer.from('test-secret'))).toBe(false);
      expect(disk.includes(Buffer.from('test-account-id'))).toBe(false);
      expect((await loadSession(path))?.accountId).toBe('test-account-id');
      expect((await loadSession(path))?.storage).toEqual(storage);
      await saveSession({ cookies: [], origins: [] }, path);
      expect((await loadSession(path))?.storage.cookies).toEqual([]);
      await deleteSession(path);
      expect(await loadSession(path)).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it.skipIf(process.platform !== 'win32')('rejects corrupt ciphertext without echoing its contents', async () => {
    await expect(protectSession(Buffer.from('sensitive-invalid-ciphertext'), true))
      .rejects.toThrow('Windows could not protect or restore the consumer session.');
  }, 30_000);
});
