import type { DeliveryRecord } from '../../domain/types.js';
import type { Database } from '../database.js';
import { recordFromRow } from './index.js';
import type { DeliveryRepository } from './types.js';

export function createDeliveryRepository(db: Database): DeliveryRepository {
  return {
    async create(input) {
      const { rows } = await db.query(`INSERT INTO deliveries
        (tenant_id, doordash_delivery_id_hash, doordash_delivery_id_encrypted, external_order_reference,
         merchant_name, status, provider_status, eta_at, last_event_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`, [
        input.tenantId, input.doordashDeliveryIdHash, input.doordashDeliveryIdEncrypted ?? null,
        input.externalOrderReference ?? null, input.merchantName ?? null, input.status ?? 'unknown',
        input.providerStatus ?? null, input.etaAt ?? null, input.lastEventAt ?? null,
      ]);
      return recordFromRow<DeliveryRecord>(rows[0]!);
    },
    async findById(id) {
      const { rows } = await db.query('SELECT * FROM deliveries WHERE id = $1', [id]);
      return rows[0] ? recordFromRow<DeliveryRecord>(rows[0]) : null;
    },
    async findAccessibleForUser(deliveryId, userId) {
      const { rows } = await db.query('SELECT d.* FROM deliveries d JOIN delivery_access a ON a.delivery_id = d.id WHERE d.id = $1 AND a.user_id = $2', [deliveryId, userId]);
      return rows[0] ? recordFromRow<DeliveryRecord>(rows[0]) : null;
    },
    async findByDoordashDeliveryIdHash(hash) {
      const { rows } = await db.query('SELECT * FROM deliveries WHERE doordash_delivery_id_hash = $1', [hash]);
      return rows[0] ? recordFromRow<DeliveryRecord>(rows[0]) : null;
    },
    async listAccessibleForUser(userId, options = {}) {
      const cutoff = new Date((options.now ?? new Date()).getTime() - (options.recentWindowHours ?? 24) * 3_600_000);
      const { rows } = await db.query(`SELECT d.* FROM deliveries d
        JOIN delivery_access a ON a.delivery_id = d.id
        WHERE a.user_id = $1 AND (d.status NOT IN ('delivered', 'cancelled')
          OR ($2::boolean AND d.last_received_at >= $3))
        ORDER BY d.last_received_at DESC, d.id LIMIT $4`, [userId, options.includeRecentDelivered ?? false, cutoff, options.limit ?? 50]);
      return rows.map((row) => recordFromRow<DeliveryRecord>(row));
    },
    async applyEventProjection(input) {
      const { projection } = input;
      const { rowCount } = await db.query(`UPDATE deliveries SET status = $3, provider_status = $4,
        eta_at = $5, last_event_at = $6, last_received_at = $7, updated_at = now()
        WHERE id = $1 AND last_event_at IS NOT DISTINCT FROM $2::timestamptz`, [
        input.deliveryId, input.expectedLastEventAt, projection.status, projection.providerStatus,
        projection.etaAt, projection.lastEventAt, input.receivedAt,
      ]);
      return { updated: rowCount > 0 };
    },
    async touchLastReceived(deliveryId, receivedAt) {
      await db.query('UPDATE deliveries SET last_received_at = $2, updated_at = now() WHERE id = $1', [deliveryId, receivedAt]);
    },
  };
}
