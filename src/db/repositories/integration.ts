import type { DoorDashIntegrationRecord } from '../../domain/types.js';
import type { Database } from '../database.js';
import { recordFromRow } from './index.js';
import type { IntegrationRepository } from './types.js';

export function createIntegrationRepository(db: Database): IntegrationRepository {
  return {
    async create(input) {
      const { rows } = await db.query('INSERT INTO doordash_integrations (tenant_id, environment) VALUES ($1, $2) RETURNING *', [input.tenantId, input.environment]);
      return recordFromRow<DoorDashIntegrationRecord>(rows[0]!);
    },
    async findActiveByTenantId(tenantId) {
      const { rows } = await db.query("SELECT * FROM doordash_integrations WHERE tenant_id = $1 AND status = 'active' ORDER BY created_at DESC, id LIMIT 1", [tenantId]);
      return rows[0] ? recordFromRow<DoorDashIntegrationRecord>(rows[0]) : null;
    },
    async setStatus(id, status) {
      await db.query('UPDATE doordash_integrations SET status = $2, updated_at = now() WHERE id = $1', [id, status]);
    },
  };
}
