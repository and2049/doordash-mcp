import type { Database } from '../database.js';
import type { Repositories } from './types.js';
import { createTenantRepository } from './tenant.js';
import { createUserRepository } from './user.js';
import { createIntegrationRepository } from './integration.js';
import { createDeliveryRepository } from './delivery.js';
import { createDeliveryEventRepository } from './delivery-event.js';
import { createDeliveryAccessRepository } from './delivery-access.js';
import { createAuditLogRepository } from './audit-log.js';

export function recordFromRow<T>(row: Record<string, unknown>): T {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => {
    const name = key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
    if (key.endsWith('_at') && value !== null) {
      if (!(value instanceof Date) && typeof value !== 'string' && typeof value !== 'number') {
        throw new Error(`Invalid database timestamp: ${key}`);
      }
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) throw new Error(`Invalid database timestamp: ${key}`);
      return [name, date];
    }
    return [name, value];
  })) as T;
}

export function createRepositories(db: Database): Repositories {
  return {
    tenants: createTenantRepository(db),
    users: createUserRepository(db),
    integrations: createIntegrationRepository(db),
    deliveries: createDeliveryRepository(db),
    deliveryEvents: createDeliveryEventRepository(db),
    deliveryAccess: createDeliveryAccessRepository(db),
    auditLogs: createAuditLogRepository(db),
  };
}
