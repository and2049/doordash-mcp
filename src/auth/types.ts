export const SCOPES = {
  deliveriesRead: 'deliveries:read',
  deliveriesList: 'deliveries:list',
} as const;

export type ScopeName = (typeof SCOPES)[keyof typeof SCOPES];

export interface AuthContext {
  userId: string;
  tenantId: string;
  subject: string;
  scopes: ScopeName[];
}

export interface ExternalIdentity {
  subject: string;
  tenantRef: string;
  scopes: string[];
}

export interface AuthorizationRequest {
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  scopes: string[];
  clientId?: string;
}

export interface TokenExchangeRequest {
  code: string;
  redirectUri: string;
  codeVerifier: string;
  clientId?: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
}

export interface IdentityProvider {
  readonly kind: 'dev' | 'oidc';
  readonly issuer: string;
  authorizationUrl(request: AuthorizationRequest): Promise<string>;
  exchangeCode(request: TokenExchangeRequest): Promise<TokenResponse>;
  verifyAccessToken(token: string): Promise<ExternalIdentity>;
  issueTokenForTesting?(identity: ExternalIdentity, ttlSeconds?: number): Promise<TokenResponse>;
}

export function toKnownScopes(scopes: readonly string[]): ScopeName[] {
  const known = new Set<ScopeName>(Object.values(SCOPES));
  return scopes.filter((scope): scope is ScopeName => known.has(scope as ScopeName));
}

export function hasScope(context: AuthContext, scope: ScopeName): boolean {
  return context.scopes.includes(scope);
}
