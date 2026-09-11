import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CartService } from '../../../src/consumer/cart-service.js';
import { OrderingService } from '../../../src/consumer/ordering-service.js';
import { OrderOperations } from '../../../src/consumer/order-operations.js';
import { cart, checkout } from './cart-fixture.js';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function setup(fail = false) {
  const directory = await mkdtemp(join(tmpdir(), 'dd-order-test-'));
  directories.push(directory);
  const operations = new OrderOperations(directory);
  const request = vi.fn(async (operation: string) => {
    if (operation === 'account') return { consumer_id: 'test-account', profile_status: 'active' };
    if (operation === 'listCarts') return { data: { listCarts: [cart] } };
    if (operation === 'checkout') return { data: { orderCart: checkout } };
    if (operation === 'createOrderFromCart') {
      expect((await operations.get('test-account', cart.id))?.state).toBe('pending');
      if (fail) throw new Error('simulated-timeout-with-secret');
      return { data: { createOrderFromCart: { cartId: cart.id, orderUuid: 'test-order', token: 'never-output' } } };
    }
    return { data: { pollOrderPaymentStatus: { paid: true, paymentStatus: 1, errorType: null, clientSecret: 'never-output' } } };
  });
  const preview = await new CartService(request).preview(cart.id, 200);
  const input = { cart_id: cart.id, request_id: '00000000-0000-4000-8000-000000000001', preview_hash: preview.preview_hash, total_cents: preview.total_cents, tip_cents: 200, payment_card_id: '123' };
  return { service: new OrderingService(request, operations), request, operations, directory, input };
}

it.skipIf(process.platform !== 'win32')('submits only to a mock, persists encrypted state and deduplicates across service restart', async () => {
  const { service, request, directory, input } = await setup();
  const result = await service.place(input);
  expect(result).toMatchObject({ state: 'submitted', order_uuid: 'test-order', payment_verified: false });
  const restarted = new OrderingService(request, new OrderOperations(directory));
  expect(await restarted.place(input)).toEqual(result);
  expect(request.mock.calls.filter(([operation]) => operation === 'createOrderFromCart')).toHaveLength(1);
  expect(JSON.stringify(await restarted.status(cart.id))).not.toContain('never-output');
  for (const file of await readdir(directory)) expect((await readFile(join(directory, file))).includes(Buffer.from('test-account'))).toBe(false);
  await expect(restarted.place({ ...input, request_id: 'different' })).rejects.toThrow('ORDER_OPERATION_CONFLICT');
}, 30_000);

it.skipIf(process.platform !== 'win32')('records ambiguous outcomes and never retries them', async () => {
  const { service, request, directory, input } = await setup(true);
  expect(await service.place(input)).toMatchObject({ state: 'unknown', retry_allowed: false });
  const restarted = new OrderingService(request, new OrderOperations(directory));
  expect(await restarted.place(input)).toMatchObject({ state: 'unknown' });
  expect(request.mock.calls.filter(([operation]) => operation === 'createOrderFromCart')).toHaveLength(1);
  expect(JSON.stringify(await restarted.status(cart.id))).not.toContain('secret');
}, 30_000);

it.skipIf(process.platform !== 'win32')('rejects stale previews without dispatch and arbitrates concurrent submission claims', async () => {
  const { service, request, operations, input } = await setup();
  await expect(service.place({ ...input, total_cents: 1 })).rejects.toThrow('CHECKOUT_CHANGED');
  expect(await operations.get('test-account', cart.id)).toBeNull();
  const outcomes = await Promise.allSettled([service.place(input), service.place(input)]);
  expect(outcomes.some((outcome) => outcome.status === 'fulfilled')).toBe(true);
  expect(request.mock.calls.filter(([operation]) => operation === 'createOrderFromCart')).toHaveLength(1);
}, 30_000);

it.skipIf(process.platform !== 'win32')('retains a returned order UUID if final durable write fails', async () => {
  const { service, operations, input, request } = await setup();
  vi.spyOn(operations, 'finish').mockRejectedValueOnce(new Error('simulated disk failure'));
  expect(await service.place(input)).toMatchObject({ state: 'unknown', order_uuid: 'test-order' });
  expect((await operations.get('test-account', cart.id))?.orderUuid).toBe('test-order');
  expect(request.mock.calls.filter(([operation]) => operation === 'createOrderFromCart')).toHaveLength(1);
}, 30_000);
