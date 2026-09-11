import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { PgDatabase } from '../../src/db/pg.js';
import { createRepositories } from '../../src/db/repositories/index.js';
import { createLogger } from '../../src/logging/logger.js';
import { exerciseRepositories } from '../support/test-deps.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('real Postgres repositories', () => {
  it('migrates, exercises all repositories, reuses persisted records and cleans up its tenant', async () => {
    const db = new PgDatabase(new Pool({ connectionString: process.env.TEST_DATABASE_URL, connectionTimeoutMillis: 5000 }));
    const logger = createLogger({ level: 'silent' });
    let tenantId: string | undefined;
    try {
      await runMigrations(db, logger);
      expect((await runMigrations(db, logger)).applied).toEqual([]);
      const repos = createRepositories(db);
      const tenant = await repos.tenants.create({ name: 'Gated integration repository contract' });
      tenantId = tenant.id;
      await exerciseRepositories(repos, tenant.id);
      const reused = createRepositories(db);
      expect(await reused.tenants.findById(tenant.id)).toEqual(tenant);
      const audit = await db.query<{ metadata: Record<string, unknown>; outcome: string }>('SELECT metadata, outcome FROM audit_logs WHERE tenant_id = $1', [tenant.id]);
      expect(audit.rows).toEqual([{ metadata: { checked: true }, outcome: 'success' }]);
    } finally {
      try {
        if (tenantId) {
          await db.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
          expect((await db.query('SELECT id FROM tenants WHERE id = $1', [tenantId])).rows).toEqual([]);
          expect((await db.query('SELECT id FROM deliveries WHERE tenant_id = $1', [tenantId])).rows).toEqual([]);
          expect((await db.query('SELECT id FROM audit_logs WHERE tenant_id = $1', [tenantId])).rows).toEqual([]);
        }
      } finally {
        await db.close();
      }
    }
  });
});
