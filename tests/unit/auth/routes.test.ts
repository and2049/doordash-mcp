import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerAuthRoutes, buildWwwAuthenticate } from '../../../src/auth/routes.js';
import { DevIdentityProvider } from '../../../src/auth/dev-identity-provider.js';
import { SCOPES } from '../../../src/auth/types.js';
import { loadEnv } from '../../../src/config/env.js';
import type { Repositories } from '../../../src/db/repositories/types.js';
import { createLogger } from '../../../src/logging/logger.js';
import { toSafeErrorResponse } from '../../../src/errors.js';

async function setup(existingParser = false): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify();
  if (existingParser) app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))));
  app.setErrorHandler((error, request, reply) => {
    const safe = toSafeErrorResponse(error, request.id);
    return reply.code(safe.status).send(safe.body);
  });
  const config = loadEnv({});
  await app.register(async (plugin) => registerAuthRoutes(plugin, {
    config, identityProvider: new DevIdentityProvider(config), repos: {} as Repositories, logger: createLogger({ level: 'silent' }),
  }));
  return app;
}

const verifier = 'v'.repeat(43);
const query = {
  response_type: 'code', redirect_uri: 'http://localhost/callback', state: 'state',
  code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  code_challenge_method: 'S256', scope: 'deliveries:read',
};

describe('auth routes', () => {
  it('performs a form-encoded OAuth exchange and publishes metadata', async () => {
    const app = await setup();
    try {
      const authorize = await app.inject({ url: '/oauth/authorize', query });
      expect(authorize.statusCode).toBe(302);
      const redirect = new URL(authorize.headers.location!);
      expect(redirect.pathname).toBe('/callback');
      const token = await app.inject({
        method: 'POST', url: '/oauth/token', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ grant_type: 'authorization_code', code: redirect.searchParams.get('code')!, redirect_uri: query.redirect_uri, code_verifier: verifier }).toString(),
      });
      expect(token.statusCode).toBe(200);
      expect(token.headers['cache-control']).toBe('no-store');
      expect(token.headers.pragma).toBe('no-cache');
      expect(token.json()).toMatchObject({ token_type: 'Bearer', scope: 'deliveries:read' });
      const metadata = await app.inject('/.well-known/oauth-authorization-server');
      expect(metadata.json()).toMatchObject({ scopes_supported: Object.values(SCOPES), code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
      const resource = await app.inject('/.well-known/oauth-protected-resource');
      expect(resource.json()).toMatchObject({ resource: loadEnv({}).mcpResourceUrl, bearer_methods_supported: ['header'] });
    } finally { await app.close(); }
  });

  it.each(['http://remote.test/callback', 'javascript:alert(1)', '/relative', 'https://client.test/#fragment', 'https://user:pass@client.test'])('rejects unsafe redirect %s', async (redirect_uri) => {
    const app = await setup();
    try {
      expect((await app.inject({ url: '/oauth/authorize', query: { ...query, redirect_uri } })).statusCode).toBe(400);
    } finally { await app.close(); }
  });

  it('tolerates an existing form parser and escapes the bearer challenge', async () => {
    const app = await setup(true);
    await app.close();
    expect(buildWwwAuthenticate('https://server.test/.well-known/oauth-protected-resource'))
      .toBe('Bearer resource_metadata="https://server.test/.well-known/oauth-protected-resource"');
    expect(buildWwwAuthenticate('https://server.test/"\r\n')).toBe('Bearer resource_metadata="https://server.test/\\""');
  });
});
