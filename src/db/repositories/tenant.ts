import type { TenantRecord } from '../../domain/types.js';
import type { Database } from '../database.js';
import { recordFromRow } from './index.js';
import type { TenantRepository } from './types.js';

export function createTenantRepository(db: Database): TenantRepository {
  return {
    async create(input) {
      const { rows } = await db.query('INSERT INTO tenants (name) VALUES ($1) RETURNING *', [input.name]);
      return recordFromRow<TenantRecord>(rows[0]!);
    },
    async findById(id) {
      const { rows } = await db.query('SELECT * FROM tenants WHERE id = $1', [id]);
      return rows[0] ? recordFromRow<TenantRecord>(rows[0]) : null;
    },
    async ensure(input) {
      await db.query('INSERT INTO tenants (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [input.id, input.name]);
      const { rows } = await db.query('SELECT * FROM tenants WHERE id = $1', [input.id]);
      return recordFromRow<TenantRecord>(rows[0]!);
    },
  };
}
