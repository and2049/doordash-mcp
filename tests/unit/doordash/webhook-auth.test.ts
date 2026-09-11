import { hkdfSync } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import { createWebhookTokenIssuer } from '../../../src/doordash/webhook-token.js';
import { createWebhookVerifier } from '../../../src/doordash/webhook-verifier.js';

const now = new Date('2026-09-10T12:00:00Z');
const config = { DOORDASH_WEBHOOK_AUTH_MODE: 'oauth' as const, DOORDASH_WEBHOOK_OAUTH_CLIENT_ID: 'test-client', DOORDASH_WEBHOOK_OAUTH_TOKEN_TTL_SECONDS: 300, mcpIssuerUrl: 'https://example.invalid' };
const clientSecret = 'test-oauth-secret-never-log';
const secretProvider = { getWebhookVerificationSecret: vi.fn(async () => clientSecret) };
const request = { clientId: config.DOORDASH_WEBHOOK_OAUTH_CLIENT_ID, clientSecret };
const input = (headers: Record<string, string | string[] | undefined>) => ({ rawBody: Buffer.from('{}'), headers });

describe('webhook Basic authorization', () => {
  const basicSecret = 'Basic dGVzdDpmYWtl';
  const verifier = createWebhookVerifier({ config: { ...config, DOORDASH_WEBHOOK_AUTH_MODE: 'basic' }, secretProvider: { getWebhookVerificationSecret: async () => basicSecret } });

  it.each([{ Authorization: basicSecret }, { aUtHoRiZaTiOn: basicSecret }, { authorization: [basicSecret] }])('accepts the exact configured header: %j', async (headers) => {
    await expect(verifier.verify(input(headers))).resolves.toBeUndefined();
  });

  it.each([{}, { authorization: undefined }, { authorization: 'Basic wrong-secret' }, { authorization: '' }, { authorization: [basicSecret, basicSecret] }, { Authorization: basicSecret, authorization: basicSecret }])('rejects wrong, missing, or ambiguous headers: %j', async (headers) => {
    await expect(verifier.verify(input(headers))).rejects.toMatchObject({ code: 'unauthenticated', message: 'Invalid, expired, or insufficient credentials.' });
  });

  it('reports unconfigured verification without leaking material', async () => {
    const missing = createWebhookVerifier({ config: { ...config, DOORDASH_WEBHOOK_AUTH_MODE: 'basic' }, secretProvider: { getWebhookVerificationSecret: async () => null } });
    await expect(missing.verify(input({ authorization: 'private-header' }))).rejects.toMatchObject({ code: 'integration_not_configured', message: 'DoorDash integration is not configured for this account.' });
  });
});

describe('webhook OAuth tokens', () => {
  it('issues deterministic HKDF-signed JWTs with the required claims', async () => {
    const issuer = createWebhookTokenIssuer({ config, secretProvider, clock: () => now });
    const issued = await issuer.issue(request);
    expect(issued).toMatchObject({ token_type: 'Bearer', expires_in: 300 });
    const key = new Uint8Array(hkdfSync('sha256', clientSecret, '', 'doordash-webhook-token', 32));
    const verified = await jwtVerify(issued.access_token, key, { currentDate: now });
    expect(verified.protectedHeader).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(verified.payload).toEqual({ iss: config.mcpIssuerUrl, aud: 'doordash-webhooks', sub: request.clientId, iat: now.getTime() / 1000, exp: now.getTime() / 1000 + 300 });
    expect(await createWebhookTokenIssuer({ config, secretProvider, clock: () => now }).issue(request)).toEqual(issued);
    await expect(issuer.verify(issued.access_token)).resolves.toBeUndefined();
    const verifier = createWebhookVerifier({ config, secretProvider, clock: () => now });
    await expect(verifier.verify(input({ Authorization: `Bearer ${issued.access_token}` }))).resolves.toBeUndefined();
    const parts = issued.access_token.split('.');
    parts[1] = Buffer.from(JSON.stringify({ ...verified.payload, sub: 'attacker' })).toString('base64url');
    await expect(verifier.verify(input({ authorization: `Bearer ${parts.join('.')}` }))).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it.each([{ ...request, clientId: 'wrong-id' }, { ...request, clientSecret: 'wrong-secret' }, { clientId: '', clientSecret: '' }])('rejects invalid client credentials: %j', async (credentials) => {
    const issuer = createWebhookTokenIssuer({ config, secretProvider, clock: () => now });
    await expect(issuer.issue(credentials)).rejects.toMatchObject({ code: 'unauthenticated', message: 'Invalid, expired, or insufficient credentials.' });
  });

  it('rejects tokens at expiry in both issuer and verifier', async () => {
    let time = now;
    const issuer = createWebhookTokenIssuer({ config, secretProvider, clock: () => time });
    const verifier = createWebhookVerifier({ config, secretProvider, clock: () => time });
    const { access_token: token } = await issuer.issue(request);
    time = new Date(now.getTime() + 299_000);
    await expect(issuer.verify(token)).resolves.toBeUndefined();
    time = new Date(now.getTime() + 300_000);
    await expect(issuer.verify(token)).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(verifier.verify(input({ authorization: `Bearer ${token}` }))).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it.each(['iss', 'aud', 'sub', 'exp'])('rejects signed tokens with invalid %s', async (claim) => {
    const claims: Record<string, string | number> = { iss: config.mcpIssuerUrl, aud: 'doordash-webhooks', sub: request.clientId, iat: now.getTime() / 1000, exp: now.getTime() / 1000 + 300 };
    if (claim === 'exp') delete claims.exp;
    else claims[claim] = 'wrong';
    const key = new Uint8Array(hkdfSync('sha256', clientSecret, '', 'doordash-webhook-token', 32));
    const token = await new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).sign(key);
    await expect(createWebhookTokenIssuer({ config, secretProvider, clock: () => now }).verify(token)).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('normalizes secret lookup failures during verification', async () => {
    const issuer = createWebhookTokenIssuer({ config, secretProvider: { getWebhookVerificationSecret: async () => { throw new Error(clientSecret); } } });
    await expect(issuer.verify('private-token')).rejects.toMatchObject({ code: 'unauthenticated', message: 'Invalid, expired, or insufficient credentials.' });
  });

  it('rejects absent configuration or secrets', async () => {
    const issuer = createWebhookTokenIssuer({ config: { ...config, DOORDASH_WEBHOOK_OAUTH_CLIENT_ID: undefined }, secretProvider: { getWebhookVerificationSecret: async () => null } });
    await expect(issuer.issue(request)).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(issuer.verify('fake-token')).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('supports an injected token verifier and rejects malformed Bearer headers', async () => {
    const verify = vi.fn(async () => undefined);
    const verifier = createWebhookVerifier({ config, secretProvider, tokenIssuer: { verify } });
    await verifier.verify(input({ AUTHORIZATION: ['Bearer test-token'] }));
    expect(verify).toHaveBeenCalledExactlyOnceWith('test-token');
    for (const authorization of [undefined, 'Basic test', 'Bearer ', 'Bearer a b']) {
      await expect(verifier.verify(input({ authorization }))).rejects.toMatchObject({ code: 'unauthenticated' });
    }
    expect(verify).toHaveBeenCalledTimes(1);
  });
});
