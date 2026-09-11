import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ConsumerError, consumerRequest } from './browser-client.js';
import { ConsumerService } from './service.js';

const id = z.string().min(1).max(100);
const text = z.string().max(20_000);
export const cartSchema = z.object({
  id, subtotal: z.number().int(), total: z.number().int().nullable(), currencyCode: text, groupCart: z.boolean(), submittedAt: text.nullable(),
  isConsumerPickup: z.boolean(), hasError: z.boolean().nullable(), restaurant: z.object({ id, name: text }), menu: z.object({ id }).nullable(),
  orders: z.array(z.object({ orderItems: z.array(z.object({
    id, quantity: z.number().int(), singlePrice: z.number().int().nullable(), nestedOptions: text.nullable(), specialInstructions: text,
    item: z.object({ id, name: text }),
  })) })),
});
const checkoutSchema = cartSchema.extend({
  shouldApplyCredits: z.boolean().nullish(),
  totalCreditsAvailable: z.object({ unitAmount: z.number().int().nonnegative(), currency: text, displayString: text }).nullish(),
  total: z.number().int(),
  taxAmount: z.number().int().nullable(), tipAmount: z.number().int().nullable(), merchantTipAmount: z.number().int().nullable(), deliveryFee: z.number().int().nullable(),
  appliedServiceFee: z.number().int().nullable(), minOrderFee: z.number().int().nullable(), extraSosDeliveryFee: z.number().int().nullable(), fulfillsOwnDeliveries: z.boolean(),
  containsAlcohol: z.boolean(), isMerchantShipping: z.boolean(), isPrescriptionDelivery: z.boolean().nullable(), isBundle: z.boolean(), isCatering: z.boolean(),
  selectedDeliveryOption: z.object({ deliveryOptionType: text }).nullable(),
  orders: z.array(cartSchema.shape.orders.element.extend({ paymentCard: z.object({ id }).nullable() })),
  lineItemsList: z.array(z.object({ label: text, finalMoney: z.object({ unitAmount: z.number().int(), displayString: text }).nullable() })),
});

export const selectionSchema = z.object({
  id: z.string().regex(/^\d{1,30}$/), quantity: z.number().int().min(1).max(99),
  options: z.array(z.object({ id: z.string().regex(/^\d{1,30}$/), quantity: z.number().int().min(1).max(99) })).max(100).default([]),
});
export type Selection = z.infer<typeof selectionSchema>;
export type Cart = z.infer<typeof cartSchema>;

export class CartService {
  constructor(private readonly request: typeof consumerRequest = consumerRequest) {}

  async accountId(): Promise<string> { return (await new ConsumerService(this.request).accountStatus()).account_id; }

  private async data(operation: Parameters<typeof consumerRequest>[0], variables: Record<string, unknown>, key: string, accountId?: string): Promise<unknown> {
    const response = z.object({ data: z.record(z.string(), z.unknown()) }).parse(await this.request(operation, variables, accountId));
    if (response.data[key] === undefined || response.data[key] === null) throw new ConsumerError('PROVIDER_DATA_UNAVAILABLE');
    return response.data[key];
  }

  async list(accountId?: string): Promise<Cart[]> {
    const data = await this.data('listCarts', { input: {
      cartContextFilter: { experienceCase: 'MULTI_CART_EXPERIENCE_CONTEXT', multiCartExperienceContext: {} },
      cartFilter: { shouldIncludeSubmitted: false },
    } }, 'listCarts', accountId);
    return z.array(cartSchema).parse(data).filter((cart) => !cart.submittedAt);
  }

  async get(cartId: string, accountId?: string): Promise<Cart> {
    const cart = (await this.list(accountId)).find((cart) => cart.id === cartId);
    if (!cart) throw new ConsumerError('CART_NOT_FOUND');
    return cart;
  }

  private editable(cart: Cart): void {
    if (cart.groupCart || cart.submittedAt) throw new ConsumerError('CART_NOT_EDITABLE');
  }

  async add(input: { store_id: string; item_id: string; quantity: number; options: Selection[]; special_instructions: string; cart_id?: string }): Promise<Cart> {
    const accountId = await this.accountId();
    const reads = new ConsumerService((operation, variables) => this.request(operation, variables, accountId));
    const carts = await this.list(accountId);
    const cart = input.cart_id ? await this.get(input.cart_id, accountId) : carts.find((cart) => cart.restaurant.id === input.store_id);
    if (cart) { this.editable(cart); if (cart.restaurant.id !== input.store_id) throw new ConsumerError('CART_STORE_MISMATCH'); }
    const menu = await reads.menu(input.store_id);
    const item = await reads.itemOptions(input.store_id, input.item_id, cart?.isConsumerPickup ? 'PICKUP' : 'DELIVERY');
    if (item.itemHeader.quantityLimit !== null && item.itemHeader.quantityLimit > 0 && input.quantity > item.itemHeader.quantityLimit) throw new ConsumerError('ITEM_QUANTITY_LIMIT');
    const selected = input.options.map((selection) => {
      const option = item.optionLists.flatMap((group) => group.options).find((option) => option.id === selection.id);
      if (!option) throw new ConsumerError('INVALID_ITEM_OPTION');
      const nested = selection.options.map((selected) => {
        const optionValue = option.nestedExtrasList.flatMap((group) => group.options).find((option) => option.id === selected.id);
        if (!optionValue) throw new ConsumerError('INVALID_ITEM_OPTION');
        return { id: selected.id, name: optionValue.name, quantity: selected.quantity, price: optionValue.unitAmount, options: [] };
      });
      validateSelections(option.nestedExtrasList, selection.options);
      return { id: selection.id, name: option.name, quantity: selection.quantity, price: option.unitAmount, options: nested };
    });
    validateSelections(item.optionLists, input.options);
    try {
      return cartSchema.parse(await this.data('addCartItem', {
        addCartItemInput: {
          storeId: input.store_id, menuId: menu.menuBook.id, itemId: input.item_id, itemName: item.itemHeader.name,
          itemDescription: '', currency: menu.storeHeader.currency, quantity: input.quantity, nestedOptions: JSON.stringify(selected),
          specialInstructions: input.special_instructions, substitutionPreference: 'contact', unitPrice: item.itemHeader.unitAmount,
          cartId: cart?.id ?? '', isBundle: false,
        }, fulfillmentContext: { shouldUpdateFulfillment: false, fulfillmentType: cart?.isConsumerPickup ? 'Pickup' : 'Delivery' },
        shouldKeepOnlyOneActiveCart: false,
      }, 'addCartItemV2', accountId));
    } catch { throw new ConsumerError('MUTATION_OUTCOME_UNKNOWN'); }
  }

  async update(cartId: string, itemId: string, quantity: number, instructions?: string): Promise<Cart> {
    const accountId = await this.accountId();
    const cart = await this.get(cartId, accountId);
    this.editable(cart);
    const item = cart.orders.flatMap((order) => order.orderItems).find((item) => item.id === itemId);
    if (!item) throw new ConsumerError('CART_ITEM_NOT_FOUND');
    if (item.nestedOptions === null) throw new ConsumerError('ITEM_OPTIONS_UNAVAILABLE');
    try {
      return cartSchema.parse(await this.data('updateCartItemV2', {
        updateCartItemInput: { cartId, storeId: cart.restaurant.id, cartItemId: itemId, itemId: item.item.id, quantity, nestedOptions: item.nestedOptions, specialInstructions: instructions ?? item.specialInstructions },
        fulfillmentContext: { shouldUpdateFulfillment: false, fulfillmentType: cart.isConsumerPickup ? 'Pickup' : 'Delivery' },
      }, 'updateCartItemV2', accountId));
    } catch { throw new ConsumerError('MUTATION_OUTCOME_UNKNOWN'); }
  }

  async remove(cartId: string, itemId?: string): Promise<{ removed: true }> {
    const accountId = await this.accountId();
    const cart = await this.get(cartId, accountId);
    this.editable(cart);
    if (itemId && !cart.orders.some((order) => order.orderItems.some((item) => item.id === itemId))) throw new ConsumerError('CART_ITEM_NOT_FOUND');
    try {
      const result = await this.data(itemId ? 'removeCartItemV2' : 'deleteCart', itemId ? { cartId, itemId } : { cartId }, itemId ? 'removeCartItemV2' : 'deleteCart', accountId);
      if (itemId) z.object({ id }).parse(result);
      else z.literal(true).parse(result);
      return { removed: true };
    } catch { throw new ConsumerError('MUTATION_OUTCOME_UNKNOWN'); }
  }

  async preview(cartId: string, tip: number, accountId?: string, applyCredits?: boolean) {
    accountId ??= await this.accountId();
    const cart = await this.get(cartId, accountId);
    this.editable(cart);
    const checkout = checkoutSchema.parse(await this.data('checkout', { orderCartId: cartId, isCardPayment: true,
      ...(applyCredits === undefined ? {} : { shouldApplyCredits: applyCredits }) }, 'orderCart', accountId));
    if (checkout.id !== cartId || checkout.submittedAt) throw new ConsumerError('CART_NOT_EDITABLE');
    if (applyCredits !== undefined && checkout.shouldApplyCredits !== applyCredits) throw new ConsumerError('CREDITS_SELECTION_NOT_CONFIRMED');
    const total = checkout.total - (checkout.tipAmount ?? 0) + tip;
    if (!Number.isSafeInteger(total) || total < 0 || total > 2_147_483_647) throw new ConsumerError('CHECKOUT_TOTAL_UNAVAILABLE');
    const fingerprint = createHash('sha256').update(JSON.stringify({ accountId, cart, checkout, tip, applyCredits })).digest('hex');
    return { cart: checkout, apply_credits: applyCredits ?? null, credits_selected: checkout.shouldApplyCredits ?? null,
      credits_available: checkout.totalCreditsAvailable ?? null,
      tip_cents: tip, total_cents: total, preview_hash: fingerprint, checked_at: new Date().toISOString() };
  }
}

export function validateSelections(groups: { minNumOptions: number; maxNumOptions: number; options: { id: string }[] }[], selections: { id: string; quantity: number }[]): void {
  if (new Set(selections.map((option) => option.id)).size !== selections.length) throw new ConsumerError('DUPLICATE_ITEM_OPTION');
  for (const group of groups) {
    const quantity = selections.filter((selection) => group.options.some((option) => option.id === selection.id)).reduce((total, selection) => total + selection.quantity, 0);
    if (quantity < group.minNumOptions || (group.maxNumOptions > 0 && quantity > group.maxNumOptions)) throw new ConsumerError('OPTION_SELECTION_LIMIT');
  }
}
