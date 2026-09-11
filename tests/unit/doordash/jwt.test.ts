import { jwtVerify } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import { createDoorDashJwtProvider } from '../../../src/doordash/jwt.js';

const config = { DOORDASH_DEVELOPER_ID: 'test-developer', DOORDASH_KEY_ID: 'test-key' };
const now = new Date('2026-09-10T12:00:00Z');

describe('DoorDash API JWT', () => {
  it.each([
    ['base64', Buffer.from('test-signing-secret').toString('base64'), Buffer.from('test-signing-secret')],
    ['utf8 fallback', '!!!', Buffer.from('!!!')],
    ['nonempty base64 takes precedence', 'plain-secret', Buffer.from('plain-secret', 'base64')],
  ])('signs the required claims and header with %s', async (_, secret, key) => {
    const provider = createDoorDashJwtProvider({ config, secretProvider: { getDoorDashSigningSecret: vi.fn().mockResolvedValue(secret) }, clock: () => now });
    const { payload, protectedHeader } = await jwtVerify(await provider.getToken(), key, { currentDate: now });
    expect(protectedHeader).toEqual({ alg: 'HS256', typ: 'JWT', 'dd-ver': 'DD-JWT-V1' });
    expect(payload).toEqual({ aud: 'doordash', iss: 'test-developer', kid: 'test-key', iat: now.getTime() / 1000, exp: now.getTime() / 1000 + 900 });
  });

  it.each([1801, 3600, Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])('bounds TTL %s', async (ttlSeconds) => {
    const key = Buffer.from('test-signing-secret');
    const provider = createDoorDashJwtProvider({ config, ttlSeconds, secretProvider: { getDoorDashSigningSecret: vi.fn().mockResolvedValue(key.toString('base64')) }, clock: () => now });
    const { payload } = await jwtVerify(await provider.getToken(), key, { currentDate: now });
    expect(payload.exp! - payload.iat!).toBeGreaterThan(0);
    expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(1800);
    expect(Number.isInteger(payload.exp)).toBe(true);
  });

  it('caches per integration and refreshes only below 60 seconds remaining', async () => {
    let time = now.getTime();
    const getDoorDashSigningSecret = vi.fn().mockResolvedValue(Buffer.from('test-signing-secret').toString('base64'));
    const provider = createDoorDashJwtProvider({ config, secretProvider: { getDoorDashSigningSecret }, clock: () => new Date(time) });
    const first = await provider.getToken({ integrationId: 'a' });
    time += 840_000;
    expect(await provider.getToken({ integrationId: 'a' })).toBe(first);
    expect(getDoorDashSigningSecret).toHaveBeenCalledTimes(1);
    time += 1000;
    expect(await provider.getToken({ integrationId: 'a' })).not.toBe(first);
    await provider.getToken({ integrationId: 'b' });
    await provider.getToken();
    await provider.getToken({ integrationId: null });
    await provider.getToken({ integrationId: '' });
    expect(getDoorDashSigningSecret.mock.calls).toEqual([['a'], ['a'], ['b'], [null], ['']]);
  });

  it.each([
    { config: {}, secret: 'must-not-leak' },
    { config: { DOORDASH_DEVELOPER_ID: 'test-developer' }, secret: 'must-not-leak' },
    { config, secret: null },
    { config, secret: '' },
  ])('rejects missing credentials safely', async ({ config: credentials, secret }) => {
    const provider = createDoorDashJwtProvider({ config: credentials, secretProvider: { getDoorDashSigningSecret: vi.fn().mockResolvedValue(secret) } });
    await expect(provider.getToken()).rejects.toMatchObject({ code: 'integration_not_configured', message: 'DoorDash integration is not configured for this account.' });
  });
});
