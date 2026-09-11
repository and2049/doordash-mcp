import { afterEach, describe, expect, it } from 'vitest';
import { assertSanitizedToolResult, connectMcp, createTestRuntime, fixture, FIXTURES, GENERIC_NOT_FOUND, postWebhook } from '../support/test-deps.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

describe('authorized delivery status lifecycle', () => {
  it('projects authenticated webhooks and serves sanitized final status through the MCP SDK', async () => {
    const runtime = await createTestRuntime();
    cleanup.push(runtime.close);
    const { deps, app, scenario, auth } = runtime;
    expect(await deps.repos.tenants.findById(scenario.tenantId)).not.toBeNull();
    expect(await deps.repos.users.findById(scenario.userId)).not.toBeNull();
    expect(await deps.repos.deliveryAccess.find(scenario.deliveryId, scenario.userId)).toMatchObject({ relationship: 'customer' });
    const mcp = await connectMcp(deps, auth);
    cleanup.push(mcp.close);
    for (const [name, status] of [[FIXTURES.confirmed, 'driver_assigned'], [FIXTURES.pickedUp, 'picked_up'], [FIXTURES.delivered, 'delivered']] as const) {
      const response = await postWebhook(app, fixture(name));
      expect(response.statusCode).toBe(200);
      expect(response.json<unknown>()).toEqual({ status: 'applied' });
      const result = await mcp.client.callTool({ name: 'get_delivery_status', arguments: { delivery_ref: scenario.deliveryId } });
      expect(result).toMatchObject({ structuredContent: { delivery_ref: scenario.deliveryId, status, is_terminal: status === 'delivered' } });
      assertSanitizedToolResult(result, scenario.providerDeliveryId);
    }
    const before = await deps.repos.deliveries.findById(scenario.deliveryId);
    const replay = await postWebhook(app, fixture(FIXTURES.delivered));
    expect(replay.statusCode).toBe(200);
    expect(replay.json<unknown>()).toEqual({ status: 'duplicate' });
    const older = await postWebhook(app, fixture(FIXTURES.arrival));
    expect(older.statusCode).toBe(200);
    expect(older.json<unknown>()).toEqual({ status: 'stale' });
    const after = await deps.repos.deliveries.findById(scenario.deliveryId);
    expect(after).toMatchObject({ status: before?.status, providerStatus: before?.providerStatus, lastEventAt: before?.lastEventAt, etaAt: before?.etaAt });
    const result = await mcp.client.callTool({ name: 'get_delivery_status', arguments: { delivery_ref: scenario.deliveryId } });
    expect(result).toMatchObject({
      structuredContent: {
        delivery_ref: scenario.deliveryId, merchant_name: 'Test Kitchen', status: 'delivered',
        summary: 'The order was reported as delivered.', eta_at: null, eta_minutes: null,
        last_updated_at: '2026-09-10T12:30:00.123Z', is_terminal: true, data_freshness: 'fresh',
      },
    });
    assertSanitizedToolResult(result, scenario.providerDeliveryId);
    expect(await deps.repos.deliveryEvents.listByDelivery(scenario.deliveryId)).toHaveLength(4);
    expect([...deps.repos.state.audits.values()].filter((row) => row.action === 'delivery_status.webhook').map((row) => row.outcome)).toEqual(['success', 'success', 'success', 'duplicate', 'stale']);
    const other = await deps.repos.users.create({ tenantId: scenario.tenantId, externalSubject: 'second-user' });
    const unauthorized = await connectMcp(deps, { ...auth, userId: other.id, subject: other.externalSubject });
    cleanup.push(unauthorized.close);
    expect(await unauthorized.client.callTool({ name: 'get_delivery_status', arguments: { delivery_ref: scenario.deliveryId } })).toEqual({ isError: true, content: [{ type: 'text', text: GENERIC_NOT_FOUND }] });
  });
});
