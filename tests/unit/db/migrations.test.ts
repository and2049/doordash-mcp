import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../../src/db/database.js';
import { runMigrations } from '../../../src/db/migrate.js';
import { createPgliteDatabase } from '../../../src/db/pglite.js';
import { createLogger } from '../../../src/logging/logger.js';

const logger = createLogger({ level: 'silent' });
let db: Database;

beforeEach(async () => { db = await createPgliteDatabase(); });
afterEach(async () => { await db.close(); });

describe('migrations and database transactions', () => {
  it('applies the schema once and records its filename', async () => {
    expect(await runMigrations(db, logger)).toEqual({ applied: ['0001_init.sql'], skipped: [] });
    expect(await runMigrations(db, logger)).toEqual({ applied: [], skipped: ['0001_init.sql'] });
    const ledger = await db.query('SELECT * FROM schema_migrations');
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]?.applied_at).toBeInstanceOf(Date);
    const tables = await db.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
    expect(tables.rows.map((row) => row.table_name).sort()).toEqual([
      'audit_logs', 'deliveries', 'delivery_access', 'delivery_events', 'doordash_integrations', 'schema_migrations', 'tenants', 'users',
    ]);
  });

  it('rolls back failed transactions and commits successful ones', async () => {
    await runMigrations(db, logger);
    await expect(db.withTransaction(async (tx) => {
      await tx.query('INSERT INTO tenants (name) VALUES ($1)', ['rolled back']);
      throw new Error('abort');
    })).rejects.toThrow('abort');
    expect((await db.query('SELECT * FROM tenants')).rows).toEqual([]);
    await db.withTransaction(async (tx) => {
      expect((await tx.query('INSERT INTO tenants (name) VALUES ($1)', ['committed'])).rowCount).toBe(1);
    });
    expect((await db.query('SELECT * FROM tenants')).rows).toHaveLength(1);
  });

  it('enforces status constraints and cascading tenant deletion', async () => {
    await runMigrations(db, logger);
    const { rows } = await db.query<{ id: string }>("INSERT INTO tenants (name) VALUES ('tenant') RETURNING id");
    const id = rows[0]!.id;
    await expect(db.query('INSERT INTO deliveries (tenant_id, doordash_delivery_id_hash, status) VALUES ($1, $2, $3)', [id, 'invalid', 'invalid'])).rejects.toThrow();
    await db.query('INSERT INTO users (tenant_id, external_subject) VALUES ($1, $2)', [id, 'subject']);
    await db.query('DELETE FROM tenants WHERE id = $1', [id]);
    expect((await db.query('SELECT * FROM users')).rows).toEqual([]);
  });
});
