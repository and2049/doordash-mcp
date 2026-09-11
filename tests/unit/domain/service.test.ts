import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../../src/auth/types.js';
import type { Repositories } from '../../../src/db/repositories/types.js';
import { createDeliveryStatusService } from '../../../src/domain/service.js';
import { NORMALIZED_DELIVERY_STATUSES } from '../../../src/domain/status.js';
import type { DeliveryRecord } from '../../../src/domain/types.js';
import { Errors } from '../../../src/errors.js';

const now = new Date('2026-09-10T12:00:00.000Z');
const auth: AuthContext = { userId: 'user-1', tenantId: 'tenant-1', subject: 'subject-1', scopes: [] };
const record: DeliveryRecord = {
  id: 'a0000000-0000-4000-8000-000000000001',
  tenantId: auth.tenantId,
  doordashDeliveryIdHash: 'private-hash',
  doordashDeliveryIdEncrypted: 'private-ciphertext',
  externalOrderReference: 'private-order',
  merchantName: 'Sample Cafe',
  status: 'picked_up',
  providerStatus: 'private-provider-status',
  etaAt: new Date('2026-09-10T12:10:01.000Z'),
  lastEventAt: new Date('2026-09-10T11:59:00.000Z'),
  lastReceivedAt: now,
  createdAt: now,
  updatedAt: now,
};
const sensitiveKeys = /address|phone|location|lat|lng|dasher|driver|coordinate/i;

function setup(accessible: DeliveryRecord | null = record, listed: DeliveryRecord[] = [record]) {
  const unused = async (): Promise<never> => { throw new Error('Unexpected repository call'); };
  const findAccessibleForUser = vi.fn<Repositories['deliveries']['findAccessibleForUser']>()
    .mockResolvedValue(accessible);
  const listAccessibleForUser = vi.fn<Repositories['deliveries']['listAccessibleForUser']>()
    .mockResolvedValue(listed);
  const repos: Repositories = {
    tenants: { create: unused, findById: unused, ensure: unused },
    users: { create: unused, findById: unused, findByExternalSubject: unused, ensure: unused },
    integrations: { create: unused, findActiveByTenantId: unused, setStatus: unused },
    deliveries: {
      create: unused, findById: unused, findAccessibleForUser, findByDoordashDeliveryIdHash: unused,
      listAccessibleForUser, applyEventProjection: unused, touchLastReceived: unused,
    },
    deliveryEvents: { insertIfAbsent: unused, listByDelivery: unused },
    deliveryAccess: { create: unused, find: unused },
    auditLogs: { insert: unused },
  };
  const service = createDeliveryStatusService({
    repos,
    freshness: { delayedAfterSeconds: 180, staleAfterSeconds: 900 },
    recentDeliveredWindowHours: 24,
    clock: () => now,
  });
  return { service, findAccessibleForUser, listAccessibleForUser };
}

describe('delivery status service', () => {
  it('returns exactly the safe status fields for an accessible delivery', async () => {
    const { service, findAccessibleForUser } = setup();
    const output = await service.getDeliveryStatus(auth, { delivery_ref: record.id });
    expect(findAccessibleForUser).toHaveBeenCalledExactlyOnceWith(record.id, auth.userId);
    expect(output).toEqual({
      delivery_ref: record.id,
      merchant_name: 'Sample Cafe',
      status: 'picked_up',
      summary: 'The order has been picked up.',
      eta_at: '2026-09-10T12:10:01.000Z',
      eta_minutes: 11,
      last_updated_at: '2026-09-10T11:59:00.000Z',
      is_terminal: false,
      data_freshness: 'fresh',
    });
    expect(JSON.stringify(output)).not.toMatch(sensitiveKeys);
    expect(JSON.stringify(output)).not.toMatch(/private-|provider|payload|payment/i);
  });

  it.each([null, { ...record, tenantId: 'other-tenant' }])('uses identical errors for inaccessible records', async (accessible) => {
    const { service } = setup(accessible);
    await expect(service.getDeliveryStatus(auth, { delivery_ref: record.id })).rejects.toMatchObject({
      code: Errors.deliveryNotFound().code,
      message: Errors.deliveryNotFound().message,
      httpStatus: 404,
    });
  });

  it.each(['', 'provider-id', 'not-a-uuid', `${record.id}x`, ` ${record.id}`])('rejects malformed ref %s before querying', async (delivery_ref) => {
    const { service, findAccessibleForUser } = setup();
    await expect(service.getDeliveryStatus(auth, { delivery_ref })).rejects.toMatchObject({
      code: Errors.deliveryNotFound().code,
      message: Errors.deliveryNotFound().message,
      httpStatus: 404,
    });
    expect(findAccessibleForUser).not.toHaveBeenCalled();
  });

  it.each([null, new Date('2026-09-10T11:59:59.999Z'), new Date(NaN)])('returns null ETA minutes for missing, past or invalid ETA %s', async (etaAt) => {
    const { service } = setup({ ...record, etaAt });
    const output = await service.getDeliveryStatus(auth, { delivery_ref: record.id });
    expect(output.eta_minutes).toBeNull();
    if (etaAt === null || Number.isNaN(etaAt.getTime())) expect(output.eta_at).toBeNull();
  });

  it('returns zero minutes when ETA equals now', async () => {
    const { service } = setup({ ...record, etaAt: now });
    expect((await service.getDeliveryStatus(auth, { delivery_ref: record.id })).eta_minutes).toBe(0);
  });

  it('withholds ETA minutes and adds the staleness note at the stale boundary', async () => {
    const { service } = setup({ ...record, lastEventAt: new Date('2026-09-10T11:45:00.000Z') });
    const output = await service.getDeliveryStatus(auth, { delivery_ref: record.id });
    expect(output.data_freshness).toBe('stale');
    expect(output.eta_minutes).toBeNull();
    expect(output.eta_at).toBe(record.etaAt?.toISOString());
    expect(output.summary).toContain('Status data is stale. Last provider update was 15 minutes ago.');
  });

  it('keeps ETA minutes for delayed data', async () => {
    const { service } = setup({ ...record, lastEventAt: new Date('2026-09-10T11:57:00.000Z') });
    const output = await service.getDeliveryStatus(auth, { delivery_ref: record.id });
    expect(output.data_freshness).toBe('delayed');
    expect(output.eta_minutes).toBe(11);
    expect(output.summary).not.toContain('stale');
  });

  it('falls back to receipt time for display but keeps unknown provider freshness', async () => {
    const { service } = setup({ ...record, lastEventAt: null, merchantName: null });
    const output = await service.getDeliveryStatus(auth, { delivery_ref: record.id });
    expect(output.last_updated_at).toBe(now.toISOString());
    expect(output.data_freshness).toBe('unknown');
    expect(output.merchant_name).toBeNull();
  });

  it.each(NORMALIZED_DELIVERY_STATUSES)('uses safe keys and the correct terminal flag for %s', async (status) => {
    const { service } = setup({ ...record, status }, [{ ...record, status }]);
    const output = await service.getDeliveryStatus(auth, { delivery_ref: record.id });
    const list = await service.listActiveDeliveries(auth, {});
    expect(JSON.stringify(Object.keys(output))).not.toMatch(sensitiveKeys);
    expect(JSON.stringify(Object.keys(list.deliveries[0] ?? {}))).not.toMatch(sensitiveKeys);
    expect(output.is_terminal).toBe(status === 'delivered' || status === 'cancelled');
  });

  it.each([undefined, false, true])('passes through list filter %s and returns exactly list fields', async (include_recent_delivered) => {
    const { service, listAccessibleForUser } = setup();
    const output = await service.listActiveDeliveries(auth, { include_recent_delivered });
    expect(listAccessibleForUser).toHaveBeenCalledExactlyOnceWith(auth.userId, {
      includeRecentDelivered: include_recent_delivered ?? false,
      recentWindowHours: 24,
      now,
    });
    expect(output).toEqual({ deliveries: [{
      delivery_ref: record.id,
      merchant_name: 'Sample Cafe',
      status: 'picked_up',
      summary: 'The order has been picked up.',
      eta_at: '2026-09-10T12:10:01.000Z',
      last_updated_at: '2026-09-10T11:59:00.000Z',
      is_terminal: false,
    }] });
    expect(JSON.stringify(output)).not.toMatch(sensitiveKeys);
    expect(JSON.stringify(output)).not.toMatch(/private-|provider|payload|payment/i);
  });

  it('excludes wrong-tenant list records defensively', async () => {
    const { service } = setup(record, [record, { ...record, tenantId: 'other-tenant' }]);
    expect((await service.listActiveDeliveries(auth, {})).deliveries).toHaveLength(1);
  });

  it('returns an empty list when no deliveries are accessible', async () => {
    const { service } = setup(null, []);
    expect(await service.listActiveDeliveries(auth, {})).toEqual({ deliveries: [] });
  });
});
