import type { UserRecord } from '../../domain/types.js';
import type { Database } from '../database.js';
import { recordFromRow } from './index.js';
import type { UserRepository } from './types.js';

export function createUserRepository(db: Database): UserRepository {
  return {
    async create(input) {
      const { rows } = await db.query('INSERT INTO users (tenant_id, external_subject, display_name) VALUES ($1, $2, $3) RETURNING *', [input.tenantId, input.externalSubject, input.displayName ?? null]);
      return recordFromRow<UserRecord>(rows[0]!);
    },
    async findById(id) {
      const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [id]);
      return rows[0] ? recordFromRow<UserRecord>(rows[0]) : null;
    },
    async findByExternalSubject(tenantId, externalSubject) {
      const { rows } = await db.query('SELECT * FROM users WHERE tenant_id = $1 AND external_subject = $2', [tenantId, externalSubject]);
      return rows[0] ? recordFromRow<UserRecord>(rows[0]) : null;
    },
    async ensure(input) {
      await db.query('INSERT INTO users (tenant_id, external_subject, display_name) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, external_subject) DO NOTHING', [input.tenantId, input.externalSubject, input.displayName ?? null]);
      const { rows } = await db.query('SELECT * FROM users WHERE tenant_id = $1 AND external_subject = $2', [input.tenantId, input.externalSubject]);
      return recordFromRow<UserRecord>(rows[0]!);
    },
  };
}
