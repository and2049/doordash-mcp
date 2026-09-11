import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../../src/db/database.js';
import { runMigrations } from '../../../src/db/migrate.js';
import { createPgliteDatabase } from '../../../src/db/pglite.js';
import { createRepositories, recordFromRow } from '../../../src/db/repositories/index.js';
import type { Repositories } from '../../../src/db/repositories/types.js';
import type { NewDeliveryEvent } from '../../../src/domain/types.js';
import { createLogger } from '../../../src/logging/logger.js';

let db: Database;
let repos: Repositories;
let tenantId: string;
let userId: string;
const now = new Date('2026-09-10T12:00:00Z');

beforeEach(async () => {
  db = await createPgliteDatabase({ dataDir: ':memory:' });
  await runMigrations(db, createLogger({ level: 'silent' }));
  repos = createRepositories(db);
  tenantId = (await repos.tenants.create({ name: 'Tenant' })).id;
  userId = (await repos.users.create({ tenantId, externalSubject: 'user' })).id;
});
afterEach(async () => { await db.close(); });

describe('repositories', () => {
  it('ensures tenants and users idempotently without overwriting records', async () => {
    const input = { id: randomUUID(), name: 'Ensured' };
    const tenant = await repos.tenants.ensure(input);
    expect(await repos.tenants.ensure({ ...input, name: 'Changed' })).toEqual(tenant);
    expect(await repos.tenants.findById(input.id)).toEqual(tenant);
    const userInput = { tenantId: tenant.id, externalSubject: 'subject', displayName: 'Name' };
    const user = await repos.users.ensure(userInput);
    expect(await repos.users.ensure({ ...userInput, displayName: 'Changed' })).toEqual(user);
    expect(await repos.users.findById(user.id)).toEqual(user);
    expect(await repos.users.findByExternalSubject(tenant.id, 'subject')).toEqual(user);
    expect(await repos.users.findByExternalSubject(tenantId, 'subject')).toBeNull();
    expect(tenant.createdAt).toBeInstanceOf(Date);
  });

  it('creates deliveries and requires an access grant for user lookup', async () => {
    const delivery = await repos.deliveries.create({ tenantId, doordashDeliveryIdHash: 'hash', doordashDeliveryIdEncrypted: 'ciphertext', merchantName: 'Merchant', etaAt: now });
    expect(delivery).toMatchObject({ status: 'unknown', merchantName: 'Merchant', etaAt: now, providerStatus: null, lastEventAt: null });
    expect(delivery.createdAt).toBeInstanceOf(Date);
    expect(await repos.deliveries.findAccessibleForUser(delivery.id, userId)).toBeNull();
    const grant = await repos.deliveryAccess.create({ deliveryId: delivery.id, userId, relationship: 'customer' });
    expect(await repos.deliveryAccess.find(delivery.id, userId)).toEqual(grant);
    expect(await repos.deliveries.findAccessibleForUser(delivery.id, userId)).toEqual(delivery);
    expect(await repos.deliveries.findAccessibleForUser(delivery.id, randomUUID())).toBeNull();
    expect(await repos.deliveries.findByDoordashDeliveryIdHash('hash')).toEqual(delivery);
    expect(await repos.deliveries.findByDoordashDeliveryIdHash('missing')).toBeNull();
  });

  it('deduplicates provider events and preserves the originally stored event', async () => {
    const delivery = await repos.deliveries.create({ tenantId, doordashDeliveryIdHash: 'hash' });
    const input: NewDeliveryEvent = {
      deliveryId: delivery.id, providerEventId: 'event-1', eventType: 'delivery_update',
      providerStatus: 'picked_up', normalizedStatus: 'picked_up', occurredAt: now, receivedAt: now,
      sanitizedPayload: { nested: { safe_key: true } },
    };
    const first = await repos.deliveryEvents.insertIfAbsent(input);
    expect(first.inserted).toBe(true);
    expect(first.event).toMatchObject(input);
    expect(await repos.deliveryEvents.insertIfAbsent({ ...input, normalizedStatus: 'delivered' })).toEqual({ inserted: false, event: first.event });
    const later = await repos.deliveryEvents.insertIfAbsent({ ...input, providerEventId: 'event-2', occurredAt: new Date(now.getTime() + 1000) });
    expect(await repos.deliveryEvents.listByDelivery(delivery.id)).toEqual([later.event, first.event]);
    expect(await repos.deliveryEvents.listByDelivery(delivery.id, { limit: 1 })).toEqual([later.event]);
  });

  it('uses null-safe optimistic projection updates without imposing domain ordering rules', async () => {
    const delivery = await repos.deliveries.create({ tenantId, doordashDeliveryIdHash: 'hash' });
    const input = {
      deliveryId: delivery.id, expectedLastEventAt: null, receivedAt: now,
      projection: { status: 'delivered' as const, providerStatus: 'delivered', etaAt: null, lastEventAt: now },
    };
    expect(await repos.deliveries.applyEventProjection(input)).toEqual({ updated: true });
    expect(await repos.deliveries.applyEventProjection({ ...input, projection: { ...input.projection, lastEventAt: new Date(now.getTime() + 1000) } })).toEqual({ updated: false });
    expect(await repos.deliveries.findById(delivery.id)).toMatchObject({ ...input.projection, lastReceivedAt: now });
    const earlier = new Date(now.getTime() - 1000);
    expect(await repos.deliveries.applyEventProjection({ ...input, expectedLastEventAt: now, projection: { status: 'scheduled', providerStatus: null, etaAt: earlier, lastEventAt: earlier } })).toEqual({ updated: true });
    await repos.deliveries.touchLastReceived(delivery.id, earlier);
    expect(await repos.deliveries.findById(delivery.id)).toMatchObject({ status: 'scheduled', lastEventAt: earlier, lastReceivedAt: earlier });
  });

  it('filters active and recent terminal deliveries, orders results, and honors limits', async () => {
    const ids: string[] = [];
    for (const [index, status] of (['picked_up', 'delivered', 'cancelled', 'delivered', 'cancelled'] as const).entries()) {
      const delivery = await repos.deliveries.create({ tenantId, doordashDeliveryIdHash: `hash-${index}`, status });
      await repos.deliveryAccess.create({ deliveryId: delivery.id, userId, relationship: 'customer' });
      const hoursAgo = [30, 1, 24, 25, 26][index]!;
      await repos.deliveries.touchLastReceived(delivery.id, new Date(now.getTime() - hoursAgo * 3_600_000));
      ids.push(delivery.id);
    }
    await repos.deliveries.create({ tenantId, doordashDeliveryIdHash: 'inaccessible', status: 'picked_up' });
    const list = async (options: Parameters<typeof repos.deliveries.listAccessibleForUser>[1]): Promise<string[]> =>
      (await repos.deliveries.listAccessibleForUser(userId, options)).map((delivery) => delivery.id);
    expect(await list({ now })).toEqual([ids[0]]);
    expect(await list({ now, includeRecentDelivered: true })).toEqual([ids[1], ids[2], ids[0]]);
    expect(await list({ now, includeRecentDelivered: true, recentWindowHours: 2 })).toEqual([ids[1], ids[0]]);
    expect(await list({ now, includeRecentDelivered: true, limit: 1 })).toEqual([ids[1]]);
  });

  it('manages integration status and inserts audit metadata with nullable references', async () => {
    const integration = await repos.integrations.create({ tenantId, environment: 'sandbox' });
    expect(await repos.integrations.findActiveByTenantId(tenantId)).toEqual(integration);
    await repos.integrations.setStatus(integration.id, 'disabled');
    expect(await repos.integrations.findActiveByTenantId(tenantId)).toBeNull();
    const delivery = await repos.deliveries.create({ tenantId, doordashDeliveryIdHash: 'audit' });
    await repos.auditLogs.insert({ tenantId, userId, deliveryId: delivery.id, action: 'read', outcome: 'success', requestId: 'request', metadata: { safe: true } });
    await db.query('DELETE FROM deliveries WHERE id = $1', [delivery.id]);
    await db.query('DELETE FROM users WHERE id = $1', [userId]);
    const { rows } = await db.query('SELECT * FROM audit_logs');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenant_id: tenantId, user_id: null, delivery_id: null, action: 'read', outcome: 'success', request_id: 'request', metadata: { safe: true } });
    expect(rows[0]?.created_at).toBeInstanceOf(Date);
    await repos.auditLogs.insert({ tenantId, userId: null, deliveryId: null, action: 'denied', outcome: 'denied', requestId: 'request-2', metadata: {} });
    expect((await db.query('SELECT * FROM audit_logs')).rows).toHaveLength(2);
  });

  it('normalizes timestamp strings and rejects invalid timestamps', () => {
    expect(recordFromRow({ created_at: now.toISOString(), eta_at: null, sanitized_payload: { snake_key: true } })).toEqual({ createdAt: now, etaAt: null, sanitizedPayload: { snake_key: true } });
    expect(() => recordFromRow({ created_at: 'invalid' })).toThrow('Invalid database timestamp');
    expect(() => recordFromRow({ created_at: {} })).toThrow('Invalid database timestamp');
  });
});
