import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { ConsumerService, parseOrders, parseSearch } from '../../../src/consumer/service.js';
import { createConsumerMcpServer } from '../../../src/consumer/mcp.js';
import { OrderingService } from '../../../src/consumer/ordering-service.js';

const order = {
  id: '1', orderUuid: 'order-one', createdAt: '2026-09-01', submittedAt: '2026-09-01', cancelledAt: null, fulfilledAt: null,
  isPickup: false, store: { id: '2', name: 'Test Store' }, grandTotal: { unitAmount: 1000, currency: 'USD', decimalPlaces: 2, displayString: '$10.00' },
  orders: [{ items: [{ id: '3', name: 'Pizza', quantity: 1 }] }], paymentCard: { secret: 'never-output' },
};

describe('consumer reads', () => {
  it('strips unrequested provider fields and derives conservative history statuses', () => {
    const orders = parseOrders([order, { ...order, fulfilledAt: 'today' }, { ...order, fulfilledAt: 'today', cancelledAt: 'today' }, { ...order, submittedAt: null }]);
    expect(orders.map((order) => order.status)).toEqual(['submitted', 'fulfilled', 'cancelled', 'unknown']);
    expect(JSON.stringify(orders)).not.toContain('never-output');
    expect(() => parseOrders({})).toThrow();
  });

  it('filters non-store autocomplete entries, malformed click payloads and duplicates', () => {
    const item = (data: string) => ({ text: { title: 'Pizza', subtitle: null, description: null }, events: { click: { data } } });
    const results = parseSearch({ body: [{ body: [item('{'), item('{"uri":"/search/pizza"}'), item('{"uri":"/store/123/"}'), item('{"uri":"/store/123?secret=never-output"}')] }] });
    expect(results).toEqual([{ store_id: '123', name: 'Pizza', subtitle: null, description: null }]);
  });

  it('preserves pagination and distinguishes absent-in-page from nonexistent', async () => {
    const request = vi.fn().mockResolvedValue({ data: { getConsumerOrdersWithDetails: Array.from({ length: 20 }, () => order) } });
    const service = new ConsumerService(request);
    const found = await service.orderStatus('order-one', 0);
    expect(found.found).toBe(true);
    const absent = await service.orderStatus('older-order', 20);
    expect(absent).toMatchObject({ found: false, order: null, next_offset: 40 });
    expect(request).toHaveBeenLastCalledWith('getConsumerOrdersWithDetails', { offset: 20, limit: 20, includeCancelled: true });
    request.mockResolvedValue({ data: { getConsumerOrdersWithDetails: [] } });
    expect((await service.listOrders(40, 20)).next_offset).toBeNull();
  });

  it('requires a nonempty provider account identity', async () => {
    const service = new ConsumerService(vi.fn().mockResolvedValue({ consumer_id: '', profile_status: 'guest' }));
    await expect(service.accountStatus()).rejects.toThrow();
  });

  it('keeps read tools marked correctly beside writes, validates bounds and sanitizes provider failures through MCP', async () => {
    const request = vi.fn().mockResolvedValue({ consumer_id: 'test-account', profile_status: 'active', token: 'never-output' });
    const server = createConsumerMcpServer(new ConsumerService(request), undefined, new OrderingService(request));
    const client = new Client({ name: 'test', version: '1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      expect(tools.slice(0, 6).map((tool) => tool.name)).toEqual(['get_consumer_account_status', 'list_consumer_orders', 'get_consumer_order_status', 'search_restaurants', 'get_restaurant_menu', 'get_menu_item_options']);
      expect(tools.slice(0, 6).every((tool) => tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint === false)).toBe(true);
      expect(tools).toHaveLength(16);
      for (const name of ['add_cart_item', 'update_cart_item', 'remove_cart_item', 'clear_cart', 'place_order']) {
        expect(tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint).toBe(false);
      }
      const account = await client.callTool({ name: 'get_consumer_account_status', arguments: {} });
      expect(JSON.stringify(account)).toContain('account_verified');
      expect(JSON.stringify(account)).not.toContain('never-output');
      request.mockClear();
      expect((await client.callTool({ name: 'list_consumer_orders', arguments: { limit: 50 } })).isError).toBe(true);
      expect((await client.callTool({ name: 'get_restaurant_menu', arguments: { store_id: '../checkout' } })).isError).toBe(true);
      expect(request).not.toHaveBeenCalled();
      request.mockRejectedValue(new Error('secret-cookie never-output'));
      const failure = await client.callTool({ name: 'get_consumer_account_status', arguments: {} });
      expect(failure.isError).toBe(true);
      expect(JSON.stringify(failure)).not.toContain('never-output');
      request.mockClear();
      const placement = await client.callTool({ name: 'place_order', arguments: {
        cart_id: 'test-cart', request_id: '00000000-0000-4000-8000-000000000001', preview_hash: 'a'.repeat(64),
        total_cents: 0, tip_cents: 0, apply_credits: true,
      } });
      expect(placement.isError).toBe(true);
      expect(JSON.stringify(placement)).toContain('Do not call place_order again');
      expect(JSON.stringify(placement)).toContain('list_consumer_orders');
      expect(JSON.stringify(placement)).not.toContain('never-output');
      expect(request).toHaveBeenCalledTimes(1);
    } finally { await client.close(); await server.close(); }
  });
});
