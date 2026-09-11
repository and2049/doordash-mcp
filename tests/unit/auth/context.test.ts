import { describe, expect, it, vi } from 'vitest';
import { ensureDevAuthContext, requireScope, resolveAuthContext } from '../../../src/auth/context.js';
import { SCOPES } from '../../../src/auth/types.js';
import { loadEnv } from '../../../src/config/env.js';
import type { Repositories } from '../../../src/db/repositories/types.js';
import type { TenantRecord, UserRecord } from '../../../src/domain/types.js';
import { Errors } from '../../../src/errors.js';
import { createLogger } from '../../../src/logging/logger.js';

function fakeRepos(): { repos: Repositories; tenants: Map<string, TenantRecord>; users: Map<string, UserRecord> } {
  const tenants = new Map<string, TenantRecord>();
  const users = new Map<string, UserRecord>();
  const repos = {
    tenants: {
      findById: async (id: string) => tenants.get(id) ?? null,
      ensure: async (input: { id: string; name: string }) => {
        const tenant = tenants.get(input.id) ?? { ...input, createdAt: new Date() };
        tenants.set(input.id, tenant);
        return tenant;
      },
    },
    users: {
      findByExternalSubject: async (tenantId: string, subject: string) => users.get(`${tenantId}/${subject}`) ?? null,
      ensure: async (input: { tenantId: string; externalSubject: string }) => {
        const key = `${input.tenantId}/${input.externalSubject}`;
        const user = users.get(key) ?? { ...input, id: 'user-id', displayName: null, createdAt: new Date() };
        users.set(key, user);
        return user;
      },
    },
  } as unknown as Repositories;
  return { repos, tenants, users };
}

describe('auth context', () => {
  it('uses identical forbidden messages for unknown tenants and users', async () => {
    const { repos } = fakeRepos();
    const identity = { subject: 'unknown', tenantRef: 'tenant', scopes: [] };
    await expect(resolveAuthContext(repos, identity)).rejects.toThrow(Errors.forbidden().message);
    await repos.tenants.ensure({ id: 'tenant', name: 'Tenant' });
    await expect(resolveAuthContext(repos, identity)).rejects.toThrow(Errors.forbidden().message);
  });

  it('auto-provisions idempotently, warns and resolves known scopes', async () => {
    const { repos, tenants, users } = fakeRepos();
    const config = loadEnv({});
    const logger = createLogger({ level: 'silent' });
    const warn = vi.spyOn(logger, 'warn');
    const first = await ensureDevAuthContext(repos, config, [SCOPES.deliveriesRead], logger);
    expect(await ensureDevAuthContext(repos, config, [SCOPES.deliveriesRead], logger)).toEqual(first);
    expect(tenants.size).toBe(1);
    expect(users.size).toBe(1);
    expect(warn).toHaveBeenCalledWith('Unsafe development identity was auto-provisioned.');
    expect(await resolveAuthContext(repos, {
      subject: config.DEV_USER_ID, tenantRef: config.DEV_TENANT_ID, scopes: ['unknown', SCOPES.deliveriesRead],
    })).toEqual(first);
    expect(() => requireScope(first, SCOPES.deliveriesRead)).not.toThrow();
    expect(() => requireScope(first, SCOPES.deliveriesList)).toThrow(Errors.forbidden().message);
  });

  it('refuses auto-provisioning in production', async () => {
    const { repos, tenants } = fakeRepos();
    await expect(ensureDevAuthContext(repos, { ...loadEnv({}), isProduction: true }, [])).rejects.toThrow(Errors.forbidden().message);
    expect(tenants.size).toBe(0);
  });
});
