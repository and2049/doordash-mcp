import type { DeliveryAccessRecord } from '../../domain/types.js';
import type { Database } from '../database.js';
import { recordFromRow } from './index.js';
import type { DeliveryAccessRepository } from './types.js';

export function createDeliveryAccessRepository(db: Database): DeliveryAccessRepository {
  return {
    async create(input) {
      const { rows } = await db.query('INSERT INTO delivery_access (delivery_id, user_id, relationship) VALUES ($1, $2, $3) RETURNING *', [input.deliveryId, input.userId, input.relationship]);
      return recordFromRow<DeliveryAccessRecord>(rows[0]!);
    },
    async find(deliveryId, userId) {
      const { rows } = await db.query('SELECT * FROM delivery_access WHERE delivery_id = $1 AND user_id = $2', [deliveryId, userId]);
      return rows[0] ? recordFromRow<DeliveryAccessRecord>(rows[0]) : null;
    },
  };
}
