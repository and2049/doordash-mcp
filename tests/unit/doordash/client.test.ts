import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDoorDashClient } from '../../../src/doordash/client.js';
import { createDoorDashJwtProvider } from '../../../src/doordash/jwt.js';

const now = new Date('2026-09-10T12:00:00Z');
const config = { DOORDASH_API_TIMEOUT_MS: 10, DOORDASH_API_MAX_RETRIES: 2 };
const logger = pino({ level: 'silent' });
const jwtProvider = { getToken: vi.fn(async () => 'test-private-jwt') };
const payload = { delivery_status: 'DASHER_PICKED_UP', updated_at: '2026-09-10T12:00:00.123456Z', dropoff_time_estimated: '2026-09-10T12:30:00.123456Z', merchant_name: 'Test Kitchen', dasher_name: 'private-dasher', dropoff_address: 'private-address', dasher_location: { lat: 42 }, fee: 500 };
const success = (): Response => Response.json(payload);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('DoorDash delivery client', () => {
  it('uses the default endpoint, encodes IDs, and only returns the snapshot', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(success());
    const client = createDoorDashClient({ config, jwtProvider, logger, fetchImpl });
    expect(await client.getDelivery('fixture/id ?')).toEqual({ providerDeliveryId: 'fixture/id ?', providerStatus: payload.delivery_status, etaAt: new Date('2026-09-10T12:30:00.123Z'), occurredAt: new Date('2026-09-10T12:00:00.123Z'), merchantName: 'Test Kitchen' });
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith('https://openapi.doordash.com/drive/v2/deliveries/fixture%2Fid%20%3F', { method: 'GET', headers: { Authorization: 'Bearer test-private-jwt' }, signal: expect.any(AbortSignal) });
  });

  it('uses an overridden base URL and safe defaults for omitted fields', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ delivery_status: 'unknown' }));
    const client = createDoorDashClient({ config: { ...config, DOORDASH_API_BASE_URL: 'https://example.invalid/drive/v2/' }, jwtProvider, logger, fetchImpl, clock: () => now });
    expect(await client.getDelivery('id')).toEqual({ providerDeliveryId: 'id', providerStatus: 'unknown', etaAt: null, merchantName: null, occurredAt: now });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://example.invalid/drive/v2/deliveries/id');
  });

  it.each([400, 401, 403, 404, 409, 422])('does not retry HTTP %s and exposes only a safe error', async (status) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ secret: 'private-response' }, { status }));
    const client = createDoorDashClient({ config, jwtProvider, logger, fetchImpl, retryBaseDelayMs: 1 });
    const pending = client.getDelivery('id');
    await expect(pending).rejects.toMatchObject({ code: status === 401 || status === 403 ? 'integration_not_configured' : 'provider_unavailable' });
    await expect(pending).rejects.not.toHaveProperty('cause');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([429, 500, 502, 503])('retries HTTP %s with exponential backoff and recovers', async (status) => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fetchImpl = vi.fn<typeof fetch>().mockImplementationOnce(async () => new Response('', { status })).mockImplementationOnce(async () => new Response('', { status })).mockImplementationOnce(async () => success());
    const client = createDoorDashClient({ config, jwtProvider, logger, fetchImpl, retryBaseDelayMs: 1 });
    const pending = client.getDelivery('id');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ providerStatus: payload.delivery_status });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('applies jitter and caps retry delays at two seconds', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('private-network-detail')).mockRejectedValueOnce(new Error('private-network-detail')).mockResolvedValueOnce(success());
    const pending = createDoorDashClient({ config, jwtProvider, logger, fetchImpl, retryBaseDelayMs: 1000 }).getDelivery('id');
    await vi.advanceTimersByTimeAsync(1499);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ providerStatus: payload.delivery_status });
  });

  it.each(['network', 'server', 'rate-limit'])('exhausts configured retries safely for %s failures', async (kind) => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
      if (kind === 'network') throw new Error('private-network-detail');
      return Response.json({ address: 'private-response' }, { status: kind === 'server' ? 503 : 429 });
    });
    const client = createDoorDashClient({ config, jwtProvider, logger, fetchImpl, retryBaseDelayMs: 1 });
    const pending = client.getDelivery('id');
    await expect(pending).rejects.toMatchObject({ code: 'provider_unavailable', message: 'The delivery provider is temporarily unavailable.' });
    await expect(pending).rejects.not.toHaveProperty('cause');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('aborts each timed out attempt even when fetch ignores the signal', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_, init) => {
      if (init?.signal) signals.push(init.signal);
      return new Promise<Response>(() => undefined);
    });
    const pending = createDoorDashClient({ config, jwtProvider, logger, fetchImpl, retryBaseDelayMs: 1 }).getDelivery('id');
    const assertion = expect(pending).rejects.toMatchObject({ code: 'provider_unavailable' });
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(new Set(signals).size).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out a stalled response body', async () => {
    vi.useFakeTimers();
    const response = success();
    vi.spyOn(response, 'json').mockImplementation(() => new Promise(() => undefined));
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
    const pending = createDoorDashClient({ config: { ...config, DOORDASH_API_MAX_RETRIES: 0 }, jwtProvider, logger, fetchImpl }).getDelivery('id');
    const assertion = expect(pending).rejects.toMatchObject({ code: 'provider_unavailable' });
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it.each([{ dasher_name: 'private' }, { delivery_status: { address: 'private' } }, { ...payload, updated_at: 'private-invalid-date' }, { ...payload, merchant_name: { phone: 'private' } }])('rejects malformed snapshots without exposing their contents', async (body) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body));
    const pending = createDoorDashClient({ config, jwtProvider, logger, fetchImpl }).getDelivery('id');
    await expect(pending).rejects.toMatchObject({ code: 'provider_unavailable', message: 'The delivery provider is temporarily unavailable.' });
    await expect(pending).rejects.not.toHaveProperty('cause');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never logs secrets, JWTs, payloads, or raw network errors to a pino destination', async () => {
    const output: string[] = [];
    const destination = { write: (chunk: string): void => { output.push(chunk); } };
    const capturedLogger = pino({ level: 'trace' }, destination);
    const secret = Buffer.from('private-signing-material').toString('base64');
    const provider = createDoorDashJwtProvider({ config: { DOORDASH_DEVELOPER_ID: 'test-developer', DOORDASH_KEY_ID: 'test-key' }, secretProvider: { getDoorDashSigningSecret: async () => secret }, clock: () => now });
    const token = await provider.getToken();
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error(`${secret} ${token} private-address`)).mockImplementationOnce(async () => Response.json({ secret, token, address: 'private-address' }, { status: 503 })).mockImplementationOnce(async () => success());
    await createDoorDashClient({ config, jwtProvider: provider, logger: capturedLogger, fetchImpl, retryBaseDelayMs: 1 }).getDelivery('private-id');
    const logged = output.join('');
    expect(logged).toContain('Retrying DoorDash delivery request.');
    for (const sensitive of [secret, 'private-signing-material', token, 'private-address', 'private-dasher', 'private-id']) expect(logged).not.toContain(sensitive);
  });
});
