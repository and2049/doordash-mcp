import { generateKeyPair, SignJWT } from 'jose';
import type { JWTPayload } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import { OidcIdentityProvider } from '../../../src/auth/oidc-identity-provider.js';
import { createIdentityProvider } from '../../../src/auth/factory.js';
import { loadEnv } from '../../../src/config/env.js';
import { Errors } from '../../../src/errors.js';
import { createLogger } from '../../../src/logging/logger.js';

const config = loadEnv({ AUTH_MODE: 'oidc', OIDC_ISSUER_URL: 'https://issuer.test/realm', OIDC_AUDIENCE: 'audience' });
const logger = createLogger({ level: 'silent' });
const keys = await generateKeyPair('RS256');
const fetchNever: typeof fetch = async () => { throw new Error('Network forbidden'); };
const provider = new OidcIdentityProvider({ config, logger, jwks: async () => keys.publicKey, fetchImpl: fetchNever });

async function sign(claims: JWTPayload = {}): Promise<string> {
  return new SignJWT({
    iss: config.OIDC_ISSUER_URL, aud: config.OIDC_AUDIENCE, sub: 'subject', tenant_id: 'tenant',
    scope: 'deliveries:read deliveries:list', exp: Math.floor(Date.now() / 1000) + 60, ...claims,
  }).setProtectedHeader({ alg: 'RS256' }).sign(keys.privateKey);
}

describe('OidcIdentityProvider', () => {
  it('builds a vendor-neutral authorization URL', async () => {
    const url = new URL(await provider.authorizationUrl({
      redirectUri: 'https://client.test/callback', state: 'state', codeChallenge: 'challenge',
      codeChallengeMethod: 'S256', scopes: ['deliveries:read'], clientId: 'client',
    }));
    expect(url.origin + url.pathname).toBe('https://issuer.test/realm/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code', redirect_uri: 'https://client.test/callback', state: 'state',
      code_challenge: 'challenge', code_challenge_method: 'S256', scope: 'deliveries:read', client_id: 'client',
    });
    expect(createIdentityProvider({ config, logger }).kind).toBe('oidc');
  });

  it('verifies using an injected key and maps string claims', async () => {
    expect(await provider.verifyAccessToken(await sign())).toEqual({
      subject: 'subject', tenantRef: 'tenant', scopes: ['deliveries:read', 'deliveries:list'],
    });
  });

  it('maps custom and array claims', async () => {
    const mapped = new OidcIdentityProvider({
      config: { ...config, OIDC_SUBJECT_CLAIM: 'uid', OIDC_TENANT_CLAIM: 'orgs', OIDC_SCOPE_CLAIM: 'permissions' },
      logger, jwks: async () => keys.publicKey, fetchImpl: fetchNever,
    });
    expect(await mapped.verifyAccessToken(await sign({ uid: 'custom', orgs: ['first', 'second'], permissions: ['deliveries:read'] })))
      .toEqual({ subject: 'custom', tenantRef: 'first', scopes: ['deliveries:read'] });
  });

  it.each([
    { aud: 'wrong' }, { iss: 'https://wrong.test' }, { exp: 1 }, { tenant_id: [] },
    { sub: '' }, { scope: null }, { scope: [1] },
  ])('rejects invalid claims without token details: %j', async (claims) => {
    const token = await sign(claims);
    await expect(provider.verifyAccessToken(token)).rejects.toThrow(Errors.invalidCredentials().message);
    await provider.verifyAccessToken(token).catch((error: unknown) => {
      expect((error as Error).message).not.toContain(token);
    });
  });

  it('rejects a bad signature', async () => {
    const other = await generateKeyPair('RS256');
    const token = await new SignJWT({ sub: 'secret-subject' }).setProtectedHeader({ alg: 'RS256' }).sign(other.privateKey);
    await expect(provider.verifyAccessToken(token)).rejects.toThrow(Errors.invalidCredentials().message);
  });

  it('discovers once and exchanges codes using form data', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url, options) => {
      if (String(url).endsWith('openid-configuration')) {
        expect(String(url)).toBe('https://issuer.test/realm/.well-known/openid-configuration');
        return Response.json({ issuer: config.OIDC_ISSUER_URL, token_endpoint: 'https://issuer.test/token', jwks_uri: 'https://issuer.test/keys' });
      }
      expect(url).toBe('https://issuer.test/token');
      expect(options?.method).toBe('POST');
      expect(options?.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' });
      expect(Object.fromEntries(new URLSearchParams(String(options?.body)))).toEqual({
        grant_type: 'authorization_code', code: 'code', redirect_uri: 'https://client.test/callback', code_verifier: 'verifier', client_id: 'client',
      });
      return Response.json({ access_token: 'secret-access-token', token_type: 'bearer', expires_in: 60, scope: 'deliveries:read' });
    });
    const exchanging = new OidcIdentityProvider({ config, logger, fetchImpl });
    const request = { code: 'code', redirectUri: 'https://client.test/callback', codeVerifier: 'verifier', clientId: 'client' };
    expect(await exchanging.exchangeCode(request)).toEqual({ access_token: 'secret-access-token', token_type: 'Bearer', expires_in: 60, scope: 'deliveries:read' });
    await exchanging.exchangeCode(request);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it.each(['http', 'json', 'throw'])('sanitizes exchange failures: %s', async (failure) => {
    const fetchImpl: typeof fetch = async (url) => {
      if (String(url).endsWith('openid-configuration')) return Response.json({ issuer: config.OIDC_ISSUER_URL, token_endpoint: 'https://issuer.test/token', jwks_uri: 'https://issuer.test/keys' });
      if (failure === 'throw') throw new Error('secret-client-value');
      return failure === 'http' ? new Response('secret-client-value', { status: 401 }) : Response.json({ access_token: 'secret-client-value' });
    };
    await expect(new OidcIdentityProvider({ config, logger, fetchImpl }).exchangeCode({ code: 'secret-code', redirectUri: 'https://client.test', codeVerifier: 'secret-verifier' }))
      .rejects.toThrow(Errors.invalidCredentials().message);
  });
});
