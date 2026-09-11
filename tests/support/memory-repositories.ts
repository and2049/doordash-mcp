import { randomUUID } from 'node:crypto';
import { hashProviderId } from '../../src/crypto/field-crypto.js';
import type { AuditEntryInput, Repositories } from '../../src/db/repositories/types.js';
import type { DeliveryAccessRecord, DeliveryEventRecord, DeliveryRecord, DoorDashIntegrationRecord, TenantRecord, UserRecord } from '../../src/domain/types.js';

export const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7);

export interface MemoryRepositories extends Repositories {
  state: {
    tenants: Map<string, TenantRecord>;
    users: Map<string, UserRecord>;
    integrations: Map<string, DoorDashIntegrationRecord>;
    deliveries: Map<string, DeliveryRecord>;
    access: Map<string, DeliveryAccessRecord>;
    events: Map<string, DeliveryEventRecord>;
    audits: Map<string, AuditEntryInput>;
  };
}

function constraint(condition: boolean, code: string): void {
  if (!condition) throw Object.assign(new Error('Repository constraint violation.'), { code });
}

function take<T>(rows: T[], limit: number): T[] {
  constraint(Number.isInteger(limit) && limit >= 0, '2201W');
  return structuredClone(rows.slice(0, limit));
}

export function createMemoryRepositories(clock: () => Date = () => new Date()): MemoryRepositories {
  const state: MemoryRepositories['state'] = {
    tenants: new Map(), users: new Map(), integrations: new Map(), deliveries: new Map(),
    access: new Map(), events: new Map(), audits: new Map(),
  };
  const get = <T>(map: Map<string, T>, id: string): T | null => structuredClone(map.get(id) ?? null);
  const store = <T>(map: Map<string, T>, id: string, value: T): T => {
    map.set(id, structuredClone(value));
    return structuredClone(value);
  };
  const accessKey = (deliveryId: string, userId: string): string => `${deliveryId}:${userId}`;
  const repos: MemoryRepositories = {
    state,
    tenants: {
      async create(input) {
        const row = { ...input, id: randomUUID(), createdAt: clock() };
        return store(state.tenants, row.id, row);
      },
      async findById(id) { return get(state.tenants, id); },
      async ensure(input) {
        return get(state.tenants, input.id) ?? store(state.tenants, input.id, { ...input, createdAt: clock() });
      },
    },
    users: {
      async create(input) {
        constraint(state.tenants.has(input.tenantId), '23503');
        constraint(![...state.users.values()].some((row) => row.tenantId === input.tenantId && row.externalSubject === input.externalSubject), '23505');
        const row = { ...input, id: randomUUID(), displayName: input.displayName ?? null, createdAt: clock() };
        return store(state.users, row.id, row);
      },
      async findById(id) { return get(state.users, id); },
      async findByExternalSubject(tenantId, subject) {
        return structuredClone([...state.users.values()].find((row) => row.tenantId === tenantId && row.externalSubject === subject) ?? null);
      },
      async ensure(input) {
        const existing = [...state.users.values()].find((row) => row.tenantId === input.tenantId && row.externalSubject === input.externalSubject);
        return existing ? structuredClone(existing) : repos.users.create(input);
      },
    },
    integrations: {
      async create(input) {
        constraint(state.tenants.has(input.tenantId), '23503');
        const row: DoorDashIntegrationRecord = { ...input, id: randomUUID(), status: 'active', createdAt: clock(), updatedAt: clock() };
        return store(state.integrations, row.id, row);
      },
      async findActiveByTenantId(tenantId) {
        const rows = [...state.integrations.values()].filter((row) => row.tenantId === tenantId && row.status === 'active');
        rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id));
        return structuredClone(rows[0] ?? null);
      },
      async setStatus(id, status) {
        const row = state.integrations.get(id);
        if (row) store(state.integrations, id, { ...row, status, updatedAt: clock() });
      },
    },
    deliveries: {
      async create(input) {
        constraint(state.tenants.has(input.tenantId), '23503');
        constraint(![...state.deliveries.values()].some((row) => row.doordashDeliveryIdHash === input.doordashDeliveryIdHash), '23505');
        const row: DeliveryRecord = {
          ...input, id: randomUUID(), doordashDeliveryIdEncrypted: input.doordashDeliveryIdEncrypted ?? null,
          externalOrderReference: input.externalOrderReference ?? null, merchantName: input.merchantName ?? null,
          status: input.status ?? 'unknown', providerStatus: input.providerStatus ?? null,
          etaAt: input.etaAt ?? null, lastEventAt: input.lastEventAt ?? null,
          lastReceivedAt: clock(), createdAt: clock(), updatedAt: clock(),
        };
        return store(state.deliveries, row.id, row);
      },
      async findById(id) { return get(state.deliveries, id); },
      async findAccessibleForUser(deliveryId, userId) {
        return state.access.has(accessKey(deliveryId, userId)) ? get(state.deliveries, deliveryId) : null;
      },
      async findByDoordashDeliveryIdHash(hash) {
        return structuredClone([...state.deliveries.values()].find((row) => row.doordashDeliveryIdHash === hash) ?? null);
      },
      async listAccessibleForUser(userId, options = {}) {
        const cutoff = (options.now ?? clock()).getTime() - (options.recentWindowHours ?? 24) * 3_600_000;
        const rows = [...state.deliveries.values()].filter((row) => state.access.has(accessKey(row.id, userId))
          && ((!['delivered', 'cancelled'].includes(row.status)) || (options.includeRecentDelivered && row.lastReceivedAt.getTime() >= cutoff)));
        rows.sort((a, b) => b.lastReceivedAt.getTime() - a.lastReceivedAt.getTime() || a.id.localeCompare(b.id));
        return take(rows, options.limit ?? 50);
      },
      async applyEventProjection(input) {
        const row = state.deliveries.get(input.deliveryId);
        if (!row || (row.lastEventAt?.getTime() ?? null) !== (input.expectedLastEventAt?.getTime() ?? null)) return { updated: false };
        store(state.deliveries, row.id, { ...row, ...input.projection, lastReceivedAt: input.receivedAt, updatedAt: clock() });
        return { updated: true };
      },
      async touchLastReceived(id, receivedAt) {
        const row = state.deliveries.get(id);
        if (row) store(state.deliveries, id, { ...row, lastReceivedAt: receivedAt, updatedAt: clock() });
      },
    },
    deliveryAccess: {
      async create(input) {
        constraint(state.deliveries.has(input.deliveryId) && state.users.has(input.userId), '23503');
        const key = accessKey(input.deliveryId, input.userId);
        constraint(!state.access.has(key), '23505');
        return store(state.access, key, { ...input, createdAt: clock() });
      },
      async find(deliveryId, userId) { return get(state.access, accessKey(deliveryId, userId)); },
    },
    deliveryEvents: {
      async insertIfAbsent(input) {
        const existing = get(state.events, input.providerEventId);
        if (existing) return { inserted: false, event: existing };
        constraint(state.deliveries.has(input.deliveryId), '23503');
        return { inserted: true, event: store(state.events, input.providerEventId, { ...input, id: randomUUID() }) };
      },
      async listByDelivery(deliveryId, options = {}) {
        const rows = [...state.events.values()].filter((row) => row.deliveryId === deliveryId);
        rows.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || a.id.localeCompare(b.id));
        return take(rows, options.limit ?? 50);
      },
    },
    auditLogs: {
      async insert(input) {
        constraint(state.tenants.has(input.tenantId)
          && (input.userId === null || state.users.has(input.userId))
          && (input.deliveryId === null || state.deliveries.has(input.deliveryId)), '23503');
        store(state.audits, randomUUID(), input);
      },
    },
  };
  return repos;
}

export interface SeededScenario {
  tenantId: string;
  userId: string;
  deliveryId: string;
  subject: string;
  providerDeliveryId: string;
}

export async function seedScenario(repos: Repositories, options: {
  providerDeliveryId?: string;
  encryptionKey?: Buffer;
  tenantId?: string;
} = {}): Promise<SeededScenario> {
  const tenant = await repos.tenants.ensure({ id: options.tenantId ?? randomUUID(), name: 'Integration Tenant' });
  const subject = randomUUID();
  const user = await repos.users.create({ tenantId: tenant.id, externalSubject: subject });
  const providerDeliveryId = options.providerDeliveryId ?? 'fixture-delivery-001';
  const delivery = await repos.deliveries.create({
    tenantId: tenant.id, doordashDeliveryIdHash: hashProviderId(providerDeliveryId, options.encryptionKey ?? TEST_ENCRYPTION_KEY),
    merchantName: 'Test Kitchen', status: 'scheduled',
  });
  await repos.deliveryAccess.create({ deliveryId: delivery.id, userId: user.id, relationship: 'customer' });
  return { tenantId: tenant.id, userId: user.id, deliveryId: delivery.id, subject, providerDeliveryId };
}
