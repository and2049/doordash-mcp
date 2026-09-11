import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import type { AppConfig } from '../config/env.js';
import { Errors } from '../errors.js';
import { toKnownScopes } from './types.js';
import type { AuthorizationRequest, ExternalIdentity, IdentityProvider, TokenExchangeRequest, TokenResponse } from './types.js';

const signingKey = randomBytes(32);

export class DevIdentityProvider implements IdentityProvider {
  readonly kind = 'dev';
  readonly issuer: string;
  private readonly codes = new Map<string, { request: AuthorizationRequest; expiresAt: number }>();

  constructor(private readonly config: AppConfig, private readonly now: () => number = Date.now) {
    if (config.isProduction) throw Errors.forbidden('Development identity is unsafe for production.');
    this.issuer = config.mcpIssuerUrl;
  }

  async authorizationUrl(request: AuthorizationRequest): Promise<string> {
    if (request.codeChallengeMethod !== 'S256') throw Errors.invalidCredentials();
    const now = this.now();
    for (const [code, entry] of this.codes) {
      if (entry.expiresAt <= now) this.codes.delete(code);
    }
    const code = randomBytes(32).toString('base64url');
    this.codes.set(code, { request: { ...request, scopes: toKnownScopes(request.scopes) }, expiresAt: now + 300_000 });
    const url = new URL(request.redirectUri);
    url.searchParams.set('code', code);
    url.searchParams.set('state', request.state);
    return url.toString();
  }

  async exchangeCode(request: TokenExchangeRequest): Promise<TokenResponse> {
    const entry = this.codes.get(request.code);
    if (!entry || entry.expiresAt <= this.now()) {
      this.codes.delete(request.code);
      throw Errors.invalidCredentials();
    }
    const expected = Buffer.from(entry.request.codeChallenge);
    const actual = Buffer.from(createHash('sha256').update(request.codeVerifier).digest('base64url'));
    if (entry.request.redirectUri !== request.redirectUri || entry.request.clientId !== request.clientId
      || !/^[A-Za-z0-9._~-]{43,128}$/.test(request.codeVerifier)
      || expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw Errors.invalidCredentials();
    this.codes.delete(request.code);
    return this.issueTokenForTesting({
      subject: this.config.DEV_USER_ID,
      tenantRef: this.config.DEV_TENANT_ID,
      scopes: entry.request.scopes,
    });
  }

  async issueTokenForTesting(identity: ExternalIdentity, ttlSeconds = 3600): Promise<TokenResponse> {
    const scope = toKnownScopes(identity.scopes).join(' ');
    const now = Math.floor(this.now() / 1000);
    const token = await new SignJWT({ tenant_ref: identity.tenantRef, scope })
      .setProtectedHeader({ alg: 'HS256' }).setIssuer(this.issuer).setAudience(this.config.mcpResourceUrl)
      .setSubject(identity.subject).setIssuedAt(now).setExpirationTime(now + ttlSeconds).sign(signingKey);
    return { access_token: token, token_type: 'Bearer', expires_in: ttlSeconds, scope };
  }

  async verifyAccessToken(token: string): Promise<ExternalIdentity> {
    try {
      const { payload } = await jwtVerify(token, signingKey, {
        algorithms: ['HS256'], issuer: this.issuer, audience: this.config.mcpResourceUrl,
        currentDate: new Date(this.now()), requiredClaims: ['sub', 'exp', 'iat', 'tenant_ref', 'scope'],
      });
      if (!payload.sub || typeof payload.tenant_ref !== 'string' || !payload.tenant_ref
        || typeof payload.scope !== 'string') throw Errors.invalidCredentials();
      return { subject: payload.sub, tenantRef: payload.tenant_ref, scopes: toKnownScopes(payload.scope.split(/\s+/)) };
    } catch {
      throw Errors.invalidCredentials();
    }
  }
}
