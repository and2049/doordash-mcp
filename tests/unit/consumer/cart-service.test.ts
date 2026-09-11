import { expect, it, vi } from 'vitest';
import { CartService, validateSelections } from '../../../src/consumer/cart-service.js';
import { cart, checkout } from './cart-fixture.js';

it('uses separate cart-line and menu IDs for updates, preserves options and rejects other carts', async () => {
  const request = vi.fn(async (operation: string) => {
    if (operation === 'account') return { consumer_id: 'account', profile_status: 'active' };
    if (operation === 'listCarts') return { data: { listCarts: [cart] } };
    return { data: { updateCartItemV2: { ...cart, providerSecret: 'never-output' } } };
  });
  const service = new CartService(request);
  const updated = await service.update(cart.id, 'cart-line', 2);
  expect(JSON.stringify(updated)).not.toContain('never-output');
  expect(request).toHaveBeenLastCalledWith('updateCartItemV2', {
    updateCartItemInput: { cartId: cart.id, storeId: '2', cartItemId: 'cart-line', itemId: '4', quantity: 2, nestedOptions: '[]', specialInstructions: '' },
    fulfillmentContext: { shouldUpdateFulfillment: false, fulfillmentType: 'Delivery' },
  }, 'account');
  await expect(service.remove('other-cart')).rejects.toThrow('CART_NOT_FOUND');
  await expect(service.remove(cart.id, 'other-line')).rejects.toThrow('CART_ITEM_NOT_FOUND');
  expect(request.mock.calls.filter(([operation]) => operation === 'deleteCart' || operation === 'removeCartItemV2')).toHaveLength(0);
});

it('does not treat a null mutation result as success or retry it', async () => {
  const request = vi.fn(async (operation: string) => operation === 'account' ? { consumer_id: 'account', profile_status: 'active' }
    : operation === 'listCarts' ? { data: { listCarts: [cart] } } : { data: { updateCartItemV2: null } });
  await expect(new CartService(request).update(cart.id, 'cart-line', 2)).rejects.toThrow('MUTATION_OUTCOME_UNKNOWN');
  expect(request.mock.calls.filter(([operation]) => operation === 'updateCartItemV2')).toHaveLength(1);
});

it('prices preview from checkout total, preserves unknown fees and detects content changes', async () => {
  let current = checkout;
  const request = vi.fn(async (operation: string) => operation === 'account' ? { consumer_id: 'account', profile_status: 'active' }
    : operation === 'listCarts' ? { data: { listCarts: [cart] } } : { data: { orderCart: current } });
  const service = new CartService(request);
  const first = await service.preview(cart.id, 200);
  expect(first.total_cents).toBe(1600);
  expect(first.cart.taxAmount).toBeNull();
  expect((await service.preview(cart.id, 200)).preview_hash).toBe(first.preview_hash);
  current = { ...checkout, total: 1600 };
  expect((await service.preview(cart.id, 200)).preview_hash).not.toBe(first.preview_hash);
  expect(request.mock.calls.some(([operation]) => operation.startsWith('create'))).toBe(false);
});

it('enforces required, maximum and duplicate option selections', () => {
  const groups = [{ minNumOptions: 1, maxNumOptions: 2, options: [{ id: '1' }] }];
  expect(() => validateSelections(groups, [])).toThrow('OPTION_SELECTION_LIMIT');
  expect(() => validateSelections(groups, [{ id: '1', quantity: 3 }])).toThrow('OPTION_SELECTION_LIMIT');
  expect(() => validateSelections(groups, [{ id: '1', quantity: 1 }, { id: '1', quantity: 1 }])).toThrow('DUPLICATE_ITEM_OPTION');
  expect(() => validateSelections(groups, [{ id: '1', quantity: 2 }])).not.toThrow();
});
