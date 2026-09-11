import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config/env.js';
import type { Repositories } from '../db/repositories/types.js';
import { Errors } from '../errors.js';
import type { Logger } from '../logging/logger.js';
import { SCOPES } from './types.js';
import type { IdentityProvider } from './types.js';

const redirectUri = z.url().refine((value) => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return !url.username && !url.password && !url.hash && (url.protocol === 'https:'
    || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
});
const authorizeSchema = z.object({
  response_type: z.literal('code'), redirect_uri: redirectUri, state: z.string().min(1),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code_challenge_method: z.literal('S256'),
  client_id: z.string().min(1).optional(), scope: z.string().default(''),
});
const exchangeSchema = z.object({
  grant_type: z.literal('authorization_code'), code: z.string().min(1), redirect_uri: redirectUri,
  code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/), client_id: z.string().min(1).optional(),
});

export function buildWwwAuthenticate(resourceMetadataUrl: string): string {
  return `Bearer resource_metadata="${resourceMetadataUrl.replace(/[\r\n]/g, '').replace(/["\\]/g, '\\$&')}"`;
}

export async function registerAuthRoutes(app: FastifyInstance, deps: {
  config: AppConfig; identityProvider: IdentityProvider; repos: Repositories; logger: Logger;
}): Promise<void> {
  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) {
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
      const params = new URLSearchParams(String(body));
      if ([...params.keys()].some((key) => params.getAll(key).length !== 1)) {
        done(Errors.validation());
        return;
      }
      done(null, Object.fromEntries(params));
    });
  }
  app.get('/oauth/authorize', async (request, reply) => {
    const parsed = authorizeSchema.safeParse(request.query);
    if (!parsed.success) throw Errors.validation();
    const query = parsed.data;
    const url = await deps.identityProvider.authorizationUrl({
      redirectUri: query.redirect_uri, state: query.state, codeChallenge: query.code_challenge,
      codeChallengeMethod: query.code_challenge_method, scopes: query.scope.split(/\s+/).filter(Boolean),
      clientId: query.client_id,
    });
    return reply.redirect(url, 302);
  });
  app.post('/oauth/token', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache');
    const parsed = exchangeSchema.safeParse(request.body);
    if (!parsed.success) throw Errors.validation();
    const body = parsed.data;
    return deps.identityProvider.exchangeCode({
      code: body.code, redirectUri: body.redirect_uri, codeVerifier: body.code_verifier, clientId: body.client_id,
    });
  });
  const issuer = deps.config.mcpIssuerUrl;
  app.get('/.well-known/oauth-authorization-server', async () => ({
    issuer, authorization_endpoint: `${issuer.replace(/\/+$/, '')}/oauth/authorize`,
    token_endpoint: `${issuer.replace(/\/+$/, '')}/oauth/token`, response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'], code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'], scopes_supported: Object.values(SCOPES),
  }));
  app.get('/.well-known/oauth-protected-resource', async () => ({
    resource: deps.config.mcpResourceUrl, authorization_servers: [issuer],
    scopes_supported: Object.values(SCOPES), bearer_methods_supported: ['header'],
  }));
}
