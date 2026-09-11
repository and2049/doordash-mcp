import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CartService } from '../../../src/consumer/cart-service.js';
import { OrderingService } from '../../../src/consumer/ordering-service.js';
import type { PlaceOrderInput } from '../../../src/consumer/ordering-service.js';
import { OrderOperations } from '../../../src/consumer/order-operations.js';
import { cart, checkout } from './cart-fixture.js';
import { ConsumerError } from '../../../src/consumer/browser-client.js';

const directories: string[] = [];
const savedSession = { version: 1 as const, savedAt: '2026-09-11T00:00:00.000Z', accountId: 'test-account', storage: { cookies: [], origins: [] } };
const session = async () => savedSession;
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

it.skipIf(process.platform !== 'win32')('reads unknown journal state offline, retains known IDs on poll failure and respects disconnect/account changes', async () => {
  const { service, operations, input } = await setup(true);
  await service.place(input);
  const request = vi.fn(async () => { throw new ConsumerError('BROWSER_UNAVAILABLE'); });
  const offline = new OrderingService(request, operations, session);
  expect(await offline.status(cart.id)).toMatchObject({ recorded: true, state: 'unknown', source: 'local_operation_journal', retry_allowed: false,
    recovery: expect.stringContaining('list_consumer_orders') });
  expect(request).not.toHaveBeenCalled();
  const record = await operations.get('test-account', cart.id);
  if (!record) throw new Error('missing test record');
  await operations.finish({ ...record, state: 'submitted', orderUuid: 'known-order' });
  expect(await offline.status(cart.id)).toMatchObject({ state: 'submitted', order_uuid: 'known-order', payment_verified: false, payment_error: 'BROWSER_UNAVAILABLE' });
  expect(request).toHaveBeenCalledWith('pollOrderPaymentStatus', { orderId: 'known-order' }, 'test-account');
  request.mockRejectedValueOnce(new Error('secret payment response'));
  expect(await offline.status(cart.id)).toMatchObject({ order_uuid: 'known-order', payment_error: 'PAYMENT_STATUS_UNAVAILABLE' });
  await expect(new OrderingService(request, operations, async () => null).status(cart.id)).rejects.toThrow('SESSION_NOT_SAVED');
  expect(await new OrderingService(request, operations, async () => ({ ...savedSession, accountId: 'other-account' })).status(cart.id)).toMatchObject({ recorded: false });
  const changingSession = vi.fn().mockResolvedValueOnce(savedSession).mockResolvedValueOnce(null);
  await expect(new OrderingService(request, operations, changingSession).status(cart.id)).rejects.toThrow('SESSION_CHANGED_REATTACH');
});

it.skipIf(process.platform !== 'win32').each([
  { total: 0, tip: 0, credits: true, allowed: true },
  { total: 1, tip: 0, credits: true, allowed: false },
  { total: 0, tip: 1, credits: true, allowed: false },
  { total: 0, tip: 0, credits: false, allowed: false },
  { total: 0, tip: 0, credits: undefined, allowed: false },
])('allows missing card only for explicit zero-due credit checkout: %j', async ({ total, tip, credits, allowed }) => {
  const { operations, input: base } = await setup();
  const request = vi.fn(async (operation: string) => {
    if (operation === 'account') return { consumer_id: 'test-account', profile_status: 'active' };
    if (operation === 'listCarts') return { data: { listCarts: [cart] } };
    if (operation === 'checkout') return { data: { orderCart: { ...checkout, total, tipAmount: 0, shouldApplyCredits: credits ?? null,
      orders: checkout.orders.map(order => ({ ...order, paymentCard: null })) } } };
    return { data: { createOrderFromCart: { cartId: cart.id, orderUuid: 'test-credit-order' } } };
  });
  const preview = await new CartService(request).preview(cart.id, tip, undefined, credits);
  const input: PlaceOrderInput = { cart_id: cart.id, request_id: base.request_id, tip_cents: tip, total_cents: preview.total_cents,
    preview_hash: preview.preview_hash, ...(credits === undefined ? {} : { apply_credits: credits }) };
  const service = new OrderingService(request, operations, session);
  if (allowed) {
    expect(await service.place(input)).toMatchObject({ state: 'submitted', order_uuid: 'test-credit-order' });
    expect(request).toHaveBeenCalledWith('createOrderFromCart', expect.not.objectContaining({ paymentMethod: expect.anything() }), 'test-account');
    expect(request).toHaveBeenCalledWith('createOrderFromCart', expect.objectContaining({ total: 0, shouldApplyCredits: true }), 'test-account');
    expect(await service.place(input)).toMatchObject({ state: 'submitted' });
    expect(request.mock.calls.filter(([op]) => op === 'createOrderFromCart')).toHaveLength(1);
  } else {
    await expect(service.place(input)).rejects.toThrow('SELECT_PAYMENT_IN_BROWSER');
    expect(request.mock.calls.filter(([op]) => op === 'createOrderFromCart')).toHaveLength(0);
    expect(await operations.get('test-account', cart.id)).toBeNull();
  }
});
async function setup(fail = false, applyCredits?: boolean) {
  const directory = await mkdtemp(join(tmpdir(), 'dd-order-test-'));
  directories.push(directory);
  const operations = new OrderOperations(directory);
  const request = vi.fn(async (operation: string, variables?: Record<string, unknown>) => {
    if (operation === 'account') return { consumer_id: 'test-account', profile_status: 'active' };
    if (operation === 'listCarts') return { data: { listCarts: [cart] } };
    if (operation === 'checkout') return { data: { orderCart: { ...checkout, shouldApplyCredits: variables?.shouldApplyCredits ?? null } } };
    if (operation === 'createOrderFromCart') {
      expect((await operations.get('test-account', cart.id))?.state).toBe('pending');
      if (fail) throw new Error('simulated-timeout-with-secret');
      return { data: { createOrderFromCart: { cartId: cart.id, orderUuid: 'test-order', token: 'never-output' } } };
    }
    return { data: { pollOrderPaymentStatus: { paid: true, paymentStatus: 1, errorType: null, clientSecret: 'never-output' } } };
  });
  const preview = await new CartService(request).preview(cart.id, 200, undefined, applyCredits);
  const input = { cart_id: cart.id, request_id: '00000000-0000-4000-8000-000000000001', preview_hash: preview.preview_hash, total_cents: preview.total_cents, tip_cents: 200, payment_card_id: '123', ...(applyCredits === undefined ? {} : { apply_credits: applyCredits }) };
  return { service: new OrderingService(request, operations, session), request, operations, directory, input };
}

it.skipIf(process.platform !== 'win32')('submits only to a mock, persists encrypted state and deduplicates across service restart', async () => {
  const { service, request, directory, input } = await setup();
  const result = await service.place(input);
  expect(result).toMatchObject({ state: 'submitted', order_uuid: 'test-order', payment_verified: false });
  const restarted = new OrderingService(request, new OrderOperations(directory), session);
  expect(await restarted.place(input)).toEqual(result);
  expect(request.mock.calls.filter(([operation]) => operation === 'createOrderFromCart')).toHaveLength(1);
  expect(JSON.stringify(await restarted.status(cart.id))).not.toContain('never-output');
  for (const file of await readdir(directory)) expect((await readFile(join(directory, file))).includes(Buffer.from('test-account'))).toBe(false);
  await expect(restarted.place({ ...input, request_id: 'different' })).rejects.toThrow('ORDER_OPERATION_CONFLICT');
}, 30_000);

it.skipIf(process.platform !== 'win32').each([true, false])('binds credits choice %s to the preview, submission and durable retry record', async (applyCredits) => {
  const { service, request, operations, input } = await setup(false, applyCredits);
  await expect(service.place({ ...input, apply_credits: !applyCredits })).rejects.toThrow('CHECKOUT_CHANGED');
  const { apply_credits: _choice, ...omitted } = input;
  await expect(service.place(omitted)).rejects.toThrow('CHECKOUT_CHANGED');
  expect(await operations.get('test-account', cart.id)).toBeNull();
  expect(request.mock.calls.filter(([operation]) => operation === 'createOrderFromCart')).toHaveLength(0);
  expect(await service.place(input)).toMatchObject({ state: 'submitted' });
  expect(request).toHaveBeenCalledWith('createOrderFromCart', expect.objectContaining({ shouldApplyCredits: applyCredits }), 'test-account');
  await expect(service.place({ ...input, apply_credits: !applyCredits })).rejects.toThrow('ORDER_OPERATION_CONFLICT');
});

it.skipIf(process.platform !== 'win32')('records ambiguous outcomes and never retries them', async () => {
  const { service, request, directory, input } = await setup(true);
  expect(await service.place(input)).toMatchObject({ state: 'unknown', retry_allowed: false });
  const restarted = new OrderingService(request, new OrderOperations(directory), session);
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
