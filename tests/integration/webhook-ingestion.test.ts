import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseDoorDashWebhookEnvelope } from '../../src/doordash/webhook-schema.js';
import type { DeliveryRecord } from '../../src/domain/types.js';
import { seedScenario } from '../support/memory-repositories.js';
import { createTestDeps, exerciseRepositories, fixture, FIXTURES, ingestFixture, NOW } from '../support/test-deps.js';

function projection(record: DeliveryRecord | null): unknown {
  expect(record).not.toBeNull();
  return record && { status: record.status, providerStatus: record.providerStatus, etaAt: record.etaAt, lastEventAt: record.lastEventAt };
}

describe('webhook ingestion with memory repositories', () => {
  it('applies the first fixture and persists one sanitized event and audit', async () => {
    const deps = createTestDeps();
    const scenario = await seedScenario(deps.repos);
    expect(await ingestFixture(deps, FIXTURES.confirmed)).toMatchObject({ outcome: 'applied', deliveryId: scenario.deliveryId, normalizedStatus: 'driver_assigned' });
    expect(await deps.repos.deliveries.findById(scenario.deliveryId)).toMatchObject({ status: 'driver_assigned', lastEventAt: new Date('2026-09-10T12:01:00.123Z') });
    const events = await deps.repos.deliveryEvents.listByDelivery(scenario.deliveryId);
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0]?.sanitizedPayload)).not.toMatch(/"[^"\s]*(phone|address|location|dasher)[^"\s]*"\s*:/i);
    expect([...deps.repos.state.audits.values()]).toEqual([expect.objectContaining({ tenantId: scenario.tenantId, deliveryId: scenario.deliveryId, outcome: 'success' })]);
  });

  it('deduplicates identical payloads without changing the delivery or event', async () => {
    const deps = createTestDeps();
    const { deliveryId } = await seedScenario(deps.repos);
    await ingestFixture(deps, FIXTURES.pickedUp);
    const before = await deps.repos.deliveries.findById(deliveryId);
    const events = await deps.repos.deliveryEvents.listByDelivery(deliveryId);
    expect(await deps.webhookIngestion.ingest(parseDoorDashWebhookEnvelope(fixture(FIXTURES.pickedUp)), { requestId: 'duplicate-request', receivedAt: new Date(NOW.getTime() + 1000) })).toMatchObject({ outcome: 'duplicate' });
    expect(await deps.repos.deliveries.findById(deliveryId)).toEqual(before);
    expect(await deps.repos.deliveryEvents.listByDelivery(deliveryId)).toEqual(events);
    expect([...deps.repos.state.audits.values()].map((row) => row.outcome)).toEqual(['success', 'duplicate']);
  });

  it('stores an older event but preserves the newer projection and touches receipt time', async () => {
    const deps = createTestDeps();
    const { deliveryId } = await seedScenario(deps.repos);
    await ingestFixture(deps, FIXTURES.pickedUp);
    const before = projection(await deps.repos.deliveries.findById(deliveryId));
    const receivedAt = new Date(NOW.getTime() + 1000);
    expect(await deps.webhookIngestion.ingest(parseDoorDashWebhookEnvelope(fixture(FIXTURES.confirmed)), { requestId: 'older-request', receivedAt })).toMatchObject({ outcome: 'stale' });
    expect(projection(await deps.repos.deliveries.findById(deliveryId))).toEqual(before);
    expect((await deps.repos.deliveries.findById(deliveryId))?.lastReceivedAt).toEqual(receivedAt);
    expect((await deps.repos.deliveryEvents.listByDelivery(deliveryId)).map((row) => row.eventType)).toEqual(['DASHER_PICKED_UP', 'DASHER_CONFIRMED']);
    expect([...deps.repos.state.audits.values()].at(-1)).toMatchObject({ outcome: 'stale', metadata: { transitionReason: 'stale_ignored' } });
  });

  it('protects delivered status from an older pickup event', async () => {
    const deps = createTestDeps();
    const { deliveryId } = await seedScenario(deps.repos);
    await ingestFixture(deps, FIXTURES.delivered);
    const before = projection(await deps.repos.deliveries.findById(deliveryId));
    expect(await ingestFixture(deps, FIXTURES.pickedUp)).toMatchObject({ outcome: 'stale' });
    expect(projection(await deps.repos.deliveries.findById(deliveryId))).toEqual(before);
    expect((await deps.repos.deliveries.findById(deliveryId))?.status).toBe('delivered');
    expect(await deps.repos.deliveryEvents.listByDelivery(deliveryId)).toHaveLength(2);
    expect([...deps.repos.state.audits.values()].at(-1)).toMatchObject({ metadata: { transitionReason: 'terminal_protected' } });
  });

  it('ignores an unknown provider delivery without mutation or an audit row', async () => {
    const deps = createTestDeps();
    await seedScenario(deps.repos);
    const before = structuredClone(deps.repos.state);
    const envelope = parseDoorDashWebhookEnvelope({ ...fixture(FIXTURES.confirmed), external_delivery_id: 'unknown-provider-delivery' });
    expect(await deps.webhookIngestion.ingest(envelope, { requestId: randomUUID(), receivedAt: NOW })).toEqual({ outcome: 'ignored' });
    expect(deps.repos.state).toEqual(before);
    expect(deps.repos.state.audits.size).toBe(0);
  });

  it('audits every known-delivery outcome with only safe metadata keys', async () => {
    const deps = createTestDeps();
    const { tenantId, deliveryId } = await seedScenario(deps.repos);
    for (const name of [FIXTURES.pickedUp, FIXTURES.pickedUp, FIXTURES.confirmed]) await ingestFixture(deps, name);
    const audits = [...deps.repos.state.audits.values()];
    expect(audits.map((row) => row.outcome)).toEqual(['success', 'duplicate', 'stale']);
    for (const audit of audits) {
      expect(audit).toMatchObject({ tenantId, deliveryId, action: 'delivery_status.webhook', userId: null });
      expect(Object.keys(audit.metadata).sort()).toEqual(['eventType', 'normalizedStatus', 'transitionReason']);
      expect(JSON.stringify(audit.metadata)).not.toMatch(/"[^"\s]*(phone|address|location|dasher)[^"\s]*"\s*:/i);
      expect(JSON.stringify(audit.metadata)).not.toContain('fixture-delivery-001');
    }
  });

  it('implements the shared repository contract including CAS, uniqueness, access and recent-terminal windows', async () => {
    const deps = createTestDeps();
    const tenant = await deps.repos.tenants.create({ name: 'Memory contract' });
    await exerciseRepositories(deps.repos, tenant.id);
    expect(deps.repos.state.audits.size).toBe(1);
  });
});
