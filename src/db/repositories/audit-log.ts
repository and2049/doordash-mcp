import type { Database } from '../database.js';
import type { AuditLogRepository } from './types.js';

export function createAuditLogRepository(db: Database): AuditLogRepository {
  return {
    async insert(input) {
      await db.query(`INSERT INTO audit_logs
        (tenant_id, user_id, action, delivery_id, outcome, request_id, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`, [
        input.tenantId, input.userId, input.action, input.deliveryId,
        input.outcome, input.requestId, JSON.stringify(input.metadata),
      ]);
    },
  };
}
