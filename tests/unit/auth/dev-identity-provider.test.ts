import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../../src/config/env.js';
import { DevIdentityProvider } from '../../../src/auth/dev-identity-provider.js';
import { createIdentityProvider } from '../../../src/auth/factory.js';
import { createLogger } from '../../../src/logging/logger.js';
import { Errors } from '../../../src/errors.js';

const config = loadEnv({ NODE_ENV: 'test' });
const verifier = 'v'.repeat(43);
const request = {
  redirectUri: 'http://localhost/callback?existing=yes', state: 'state&value',
  codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
  codeChallengeMethod: 'S256' as const, scopes: ['deliveries:read', 'unknown'], clientId: 'client',
};
const identity = { subject: config.DEV_USER_ID, tenantRef: config.DEV_TENANT_ID, scopes: ['deliveries:read'] };

async function authorize(provider: DevIdentityProvider): Promise<string> {
  const url = new URL(await provider.authorizationUrl(request));
  expect(url.pathname).toBe('/callback');
  expect(url.searchParams.get('existing')).toBe('yes');
  expect(url.searchParams.get('state')).toBe(request.state);
  return url.searchParams.get('code')!;
}

describe('DevIdentityProvider', () => {
  it('completes PKCE and rejects code reuse', async () => {
    const provider = new DevIdentityProvider(config);
    const exchange = { code: await authorize(provider), redirectUri: request.redirectUri, codeVerifier: verifier, clientId: 'client' };
    const token = await provider.exchangeCode(exchange);
    expect(token).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'deliveries:read' });
    expect(await provider.verifyAccessToken(token.access_token)).toEqual(identity);
    await expect(provider.exchangeCode(exchange)).rejects.toThrow(Errors.invalidCredentials().message);
  });

  it.each(['verifier', 'redirect', 'client'])('rejects incorrect %s binding', async (field) => {
    const provider = new DevIdentityProvider(config);
    await expect(provider.exchangeCode({
      code: await authorize(provider), codeVerifier: field === 'verifier' ? 'x'.repeat(43) : verifier,
      redirectUri: field === 'redirect' ? 'https://wrong.test' : request.redirectUri,
      clientId: field === 'client' ? 'wrong' : 'client',
    })).rejects.toThrow(Errors.invalidCredentials().message);
  });

  it('expires codes using an injected clock', async () => {
    let now = Date.now();
    const provider = new DevIdentityProvider(config, () => now);
    const code = await authorize(provider);
    now += 300_000;
    await expect(provider.exchangeCode({ code, redirectUri: request.redirectUri, codeVerifier: verifier, clientId: 'client' }))
      .rejects.toThrow(Errors.invalidCredentials().message);
  });

  it('rejects tampered, expired and wrong-audience tokens without disclosing tokens', async () => {
    const provider = new DevIdentityProvider(config);
    const valid = await provider.issueTokenForTesting(identity);
    const expired = await provider.issueTokenForTesting(identity, -1);
    const other = await new DevIdentityProvider({ ...config, mcpResourceUrl: 'https://other.test/mcp' }).issueTokenForTesting(identity);
    const parts = valid.access_token.split('.');
    const tampered = `${parts[0]}.${Buffer.from(JSON.stringify({ sub: 'secret-subject' })).toString('base64url')}.${parts[2]}`;
    for (const token of [tampered, expired.access_token, other.access_token, 'secret-token']) {
      await expect(provider.verifyAccessToken(token)).rejects.toThrow(Errors.invalidCredentials().message);
      await provider.verifyAccessToken(token).catch((error: unknown) => {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).not.toContain(token);
        expect((error as Error).message).not.toContain('secret');
      });
    }
  });

  it('refuses production and selects dev through the factory', () => {
    expect(() => new DevIdentityProvider({ ...config, isProduction: true })).toThrow('unsafe for production');
    expect(createIdentityProvider({ config, logger: createLogger({ level: 'silent' }) }).kind).toBe('dev');
  });
});
