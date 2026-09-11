import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import type { AppConfig } from '../config/env.js';
import { Errors } from '../errors.js';
import type { Logger } from '../logging/logger.js';
import type { AuthorizationRequest, ExternalIdentity, IdentityProvider, TokenExchangeRequest, TokenResponse } from './types.js';

const discoverySchema = z.object({ issuer: z.string(), token_endpoint: z.url(), jwks_uri: z.url() });
const tokenSchema = z.object({
  access_token: z.string().min(1), token_type: z.string().regex(/^Bearer$/i),
  expires_in: z.number().int().positive(), scope: z.string().default(''),
});

export interface OidcIdentityProviderDeps {
  config: AppConfig;
  logger: Logger;
  fetchImpl?: typeof fetch;
  jwks?: JWTVerifyGetKey;
}

export class OidcIdentityProvider implements IdentityProvider {
  readonly kind = 'oidc';
  readonly issuer: string;
  private readonly config: AppConfig;
  private readonly fetchImpl: typeof fetch;
  private jwks: JWTVerifyGetKey | undefined;
  private discovery: Promise<z.infer<typeof discoverySchema>> | undefined;

  constructor(deps: OidcIdentityProviderDeps) {
    this.config = deps.config;
    if (!deps.config.OIDC_ISSUER_URL || !deps.config.OIDC_AUDIENCE) throw Errors.invalidCredentials();
    this.issuer = deps.config.OIDC_ISSUER_URL;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.jwks = deps.jwks;
  }

  private discover(): Promise<z.infer<typeof discoverySchema>> {
    this.discovery ??= (async () => {
      const response = await this.fetchImpl(new URL('.well-known/openid-configuration', `${this.issuer.replace(/\/+$/, '')}/`));
      if (!response.ok) throw Errors.invalidCredentials();
      const metadata = discoverySchema.parse(await response.json());
      if (metadata.issuer !== this.issuer) throw Errors.invalidCredentials();
      return metadata;
    })().catch(() => {
      this.discovery = undefined;
      throw Errors.invalidCredentials();
    });
    return this.discovery;
  }

  async authorizationUrl(request: AuthorizationRequest): Promise<string> {
    const url = new URL(`${this.issuer.replace(/\/+$/, '')}/authorize`);
    url.search = new URLSearchParams({
      response_type: 'code', redirect_uri: request.redirectUri, state: request.state,
      scope: request.scopes.join(' '), code_challenge: request.codeChallenge, code_challenge_method: 'S256',
      ...(request.clientId === undefined ? {} : { client_id: request.clientId }),
    }).toString();
    return url.toString();
  }

  async exchangeCode(request: TokenExchangeRequest): Promise<TokenResponse> {
    try {
      const metadata = await this.discover();
      const response = await this.fetchImpl(metadata.token_endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code', code: request.code, redirect_uri: request.redirectUri,
          code_verifier: request.codeVerifier,
          ...(request.clientId === undefined ? {} : { client_id: request.clientId }),
        }),
      });
      if (!response.ok) throw Errors.invalidCredentials();
      const token = tokenSchema.parse(await response.json());
      return { ...token, token_type: 'Bearer' };
    } catch {
      throw Errors.invalidCredentials();
    }
  }

  async verifyAccessToken(token: string): Promise<ExternalIdentity> {
    try {
      this.jwks ??= createRemoteJWKSet(new URL((await this.discover()).jwks_uri));
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.issuer, audience: this.config.OIDC_AUDIENCE, requiredClaims: ['exp'],
      });
      const subject = payload[this.config.OIDC_SUBJECT_CLAIM];
      const tenantClaim = payload[this.config.OIDC_TENANT_CLAIM];
      const tenantRef: unknown = Array.isArray(tenantClaim) ? tenantClaim[0] : tenantClaim;
      const scopeClaim = payload[this.config.OIDC_SCOPE_CLAIM];
      const scopes: unknown = typeof scopeClaim === 'string' ? scopeClaim.split(/\s+/).filter(Boolean) : scopeClaim;
      if (typeof subject !== 'string' || !subject || typeof tenantRef !== 'string' || !tenantRef
        || !Array.isArray(scopes) || !scopes.every((scope): scope is string => typeof scope === 'string')) {
        throw Errors.invalidCredentials();
      }
      return { subject, tenantRef, scopes };
    } catch {
      throw Errors.invalidCredentials();
    }
  }
}
