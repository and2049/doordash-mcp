import { expect, it, vi } from 'vitest';
import { CartService } from '../../../src/consumer/cart-service.js';
import { queries } from '../../../src/consumer/queries.js';
import { cart, checkout } from './cart-fixture.js';

it('uses provider pricing, exposes available credits and hashes the explicit choice even when prices match', async () => {
  const request = vi.fn(async (operation: string, variables?: Record<string, unknown>) => {
    if (operation === 'account') return { consumer_id: 'test-account', profile_status: 'active' };
    if (operation === 'listCarts') return { data: { listCarts: [cart] } };
    return { data: { orderCart: { ...checkout, total: 500, tipAmount: 0,
      shouldApplyCredits: variables?.shouldApplyCredits ?? true,
      totalCreditsAvailable: { unitAmount: 1000, currency: 'USD', displayString: '$10.00' } } } };
  });
  const service = new CartService(request);
  const on = await service.preview(cart.id, 0, undefined, true);
  const off = await service.preview(cart.id, 0, undefined, false);
  const omitted = await service.preview(cart.id, 0);
  expect(on).toMatchObject({ apply_credits: true, credits_selected: true, total_cents: 500, credits_available: { unitAmount: 1000 } });
  expect(off).toMatchObject({ apply_credits: false, credits_selected: false, total_cents: 500 });
  expect(omitted.apply_credits).toBeNull();
  expect(new Set([on.preview_hash, off.preview_hash, omitted.preview_hash]).size).toBe(3);
  expect(request.mock.calls.filter(([op]) => op === 'checkout').map(([, args]) => args)).toEqual([
    { orderCartId: cart.id, isCardPayment: true, shouldApplyCredits: true },
    { orderCartId: cart.id, isCardPayment: true, shouldApplyCredits: false },
    { orderCartId: cart.id, isCardPayment: true },
  ]);
  for (const query of [queries.checkout, queries.createOrderFromCart]) {
    expect(query).toContain('$shouldApplyCredits: Boolean');
    expect(query).toContain('shouldApplyCredits: $shouldApplyCredits');
  }
});

it.each([undefined, null, false])('rejects unconfirmed credits selection (%s)', async (selected) => {
  const request = vi.fn(async (operation: string) => {
    if (operation === 'account') return { consumer_id: 'test-account', profile_status: 'active' };
    if (operation === 'listCarts') return { data: { listCarts: [cart] } };
    return { data: { orderCart: { ...checkout, shouldApplyCredits: selected } } };
  });
  await expect(new CartService(request).preview(cart.id, 0, undefined, true)).rejects.toThrow('CREDITS_SELECTION_NOT_CONFIRMED');
});
