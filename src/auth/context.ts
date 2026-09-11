import type { AppConfig } from '../config/env.js';
import type { Repositories } from '../db/repositories/types.js';
import { Errors } from '../errors.js';
import type { Logger } from '../logging/logger.js';
import { hasScope, toKnownScopes } from './types.js';
import type { AuthContext, ExternalIdentity, ScopeName } from './types.js';

export async function resolveAuthContext(repos: Repositories, identity: ExternalIdentity): Promise<AuthContext> {
  const tenant = await repos.tenants.findById(identity.tenantRef);
  if (!tenant) throw Errors.forbidden();
  const user = await repos.users.findByExternalSubject(tenant.id, identity.subject);
  if (!user) throw Errors.forbidden();
  return { userId: user.id, tenantId: tenant.id, subject: identity.subject, scopes: toKnownScopes(identity.scopes) };
}

export async function ensureDevAuthContext(
  repos: Repositories, config: AppConfig, scopes: ScopeName[], logger?: Logger,
): Promise<AuthContext> {
  if (config.isProduction || config.AUTH_MODE !== 'dev') throw Errors.forbidden();
  const tenant = await repos.tenants.ensure({ id: config.DEV_TENANT_ID, name: config.DEV_TENANT_NAME });
  const user = await repos.users.ensure({ tenantId: tenant.id, externalSubject: config.DEV_USER_ID });
  logger?.warn('Unsafe development identity was auto-provisioned.');
  return { userId: user.id, tenantId: tenant.id, subject: user.externalSubject, scopes: toKnownScopes(scopes) };
}

export function requireScope(context: AuthContext, scope: ScopeName): void {
  if (!hasScope(context, scope)) throw Errors.forbidden();
}
