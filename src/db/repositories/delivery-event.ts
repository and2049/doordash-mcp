import type { DeliveryEventRecord } from '../../domain/types.js';
import type { Database } from '../database.js';
import { recordFromRow } from './index.js';
import type { DeliveryEventRepository } from './types.js';

export function createDeliveryEventRepository(db: Database): DeliveryEventRepository {
  return {
    async insertIfAbsent(input) {
      const { rows } = await db.query(`INSERT INTO delivery_events
        (delivery_id, provider_event_id, event_type, provider_status, normalized_status, occurred_at, received_at, sanitized_payload)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
        ON CONFLICT (provider_event_id) DO NOTHING RETURNING *`, [
        input.deliveryId, input.providerEventId, input.eventType, input.providerStatus,
        input.normalizedStatus, input.occurredAt, input.receivedAt, JSON.stringify(input.sanitizedPayload),
      ]);
      if (rows[0]) return { inserted: true, event: recordFromRow<DeliveryEventRecord>(rows[0]) };
      const existing = await db.query('SELECT * FROM delivery_events WHERE provider_event_id = $1', [input.providerEventId]);
      return { inserted: false, event: recordFromRow<DeliveryEventRecord>(existing.rows[0]!) };
    },
    async listByDelivery(deliveryId, options = {}) {
      const { rows } = await db.query('SELECT * FROM delivery_events WHERE delivery_id = $1 ORDER BY occurred_at DESC, id LIMIT $2', [deliveryId, options.limit ?? 50]);
      return rows.map((row) => recordFromRow<DeliveryEventRecord>(row));
    },
  };
}
