import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ConsumerError, consumerRequest } from './browser-client.js';
import { CartService } from './cart-service.js';
import { OrderOperations } from './order-operations.js';
import type { OrderOperation } from './order-operations.js';
import { ConsumerService } from './service.js';
import { loadSession } from './session-store.js';

export type PlaceOrderInput = {
  cart_id: string; request_id: string; preview_hash: string; total_cents: number; tip_cents: number; payment_card_id?: string;
  apply_credits?: boolean;
};

export class OrderingService {
  constructor(private readonly request: typeof consumerRequest = consumerRequest, private readonly operations = new OrderOperations(), private readonly session = loadSession) {}

  async place(input: PlaceOrderInput) {
    const carts = new CartService(this.request);
    const accountId = await carts.accountId();
    const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const existing = await this.operations.get(accountId, input.cart_id);
    if (existing) {
      if (existing.requestId !== input.request_id || existing.digest !== digest) throw new ConsumerError('ORDER_OPERATION_CONFLICT');
      return publicOperation(existing);
    }
    const preview = await carts.preview(input.cart_id, input.tip_cents, accountId, input.apply_credits);
    if (preview.preview_hash !== input.preview_hash || preview.total_cents !== input.total_cents) throw new ConsumerError('CHECKOUT_CHANGED');
    const cart = preview.cart;
    if (cart.hasError || cart.groupCart || cart.containsAlcohol || cart.isMerchantShipping || cart.isPrescriptionDelivery || cart.isBundle || cart.isCatering || cart.fulfillsOwnDeliveries || (cart.merchantTipAmount ?? 0) !== 0) throw new ConsumerError('UNSUPPORTED_CHECKOUT');
    if (!cart.orders.some((order) => order.orderItems.length)) throw new ConsumerError('CART_EMPTY');
    if (input.payment_card_id === undefined) {
      if (input.apply_credits !== true || cart.shouldApplyCredits !== true || cart.total !== 0 || preview.total_cents !== 0 || input.tip_cents !== 0) throw new ConsumerError('SELECT_PAYMENT_IN_BROWSER');
    } else if (!cart.orders.some((order) => order.paymentCard?.id === input.payment_card_id) || !/^\d+$/.test(input.payment_card_id) || !Number.isSafeInteger(Number(input.payment_card_id)) || Number(input.payment_card_id) > 2_147_483_647) throw new ConsumerError('SELECT_PAYMENT_IN_BROWSER');
    const record: OrderOperation = { accountId, cartId: cart.id, requestId: input.request_id, digest, createdAt: new Date().toISOString(), state: 'pending' };
    if (!await this.operations.claim(record)) throw new ConsumerError('ORDER_OPERATION_EXISTS');
    let orderUuid: string | undefined;
    try {
      const response = await this.request('createOrderFromCart', {
        cartId: cart.id, total: input.total_cents, sosDeliveryFee: cart.extraSosDeliveryFee ?? 0,
        isPickupOrder: cart.isConsumerPickup, verifiedAgeRequirement: false, deliveryTime: 'ASAP', storeId: cart.restaurant.id,
        tipAmounts: [{ tipRecipient: 'DASHER', amount: input.tip_cents }],
        ...(input.payment_card_id === undefined ? {} : { paymentMethod: Number(input.payment_card_id) }),
        isCardPayment: true, deliveryOptionType: cart.selectedDeliveryOption?.deliveryOptionType ?? 'NOT_SET',
        ...(input.apply_credits === undefined ? {} : { shouldApplyCredits: input.apply_credits }),
      }, accountId);
      const order = z.object({ data: z.object({ createOrderFromCart: z.object({ cartId: z.string(), orderUuid: z.string().min(1) }) }) }).parse(response).data.createOrderFromCart;
      if (order.cartId !== cart.id) throw new ConsumerError('PROVIDER_CART_MISMATCH');
      orderUuid = order.orderUuid;
      const submitted: OrderOperation = { ...record, state: 'submitted', orderUuid: order.orderUuid };
      await this.operations.finish(submitted);
      return publicOperation(submitted);
    } catch {
      const unknown: OrderOperation = { ...record, state: 'unknown', ...(orderUuid ? { orderUuid } : {}) };
      await this.operations.finish(unknown).catch(() => {});
      return publicOperation(unknown);
    }
  }

  async status(cartId: string) {
    const saved = await this.session().catch(() => { throw new ConsumerError('SESSION_UNREADABLE'); });
    if (!saved) throw new ConsumerError('SESSION_NOT_SAVED');
    if (!saved.accountId) throw new ConsumerError('SESSION_CHANGED_REATTACH');
    const record = await this.operations.get(saved.accountId, cartId);
    let payment;
    let paymentError: string | undefined;
    if (record?.orderUuid) {
      try { payment = await this.payment(record.orderUuid, saved.accountId); }
      catch (error) { paymentError = error instanceof ConsumerError ? error.code : 'PAYMENT_STATUS_UNAVAILABLE'; }
    }
    const current = await this.session();
    if (!current || current.accountId !== saved.accountId || current.savedAt !== saved.savedAt) throw new ConsumerError('SESSION_CHANGED_REATTACH');
    if (!record) return { recorded: false, cart_id: cartId, source: 'local_operation_journal' };
    return { recorded: true, ...publicOperation(record), source: 'local_operation_journal', payment_verified: payment?.paid === true,
      ...(payment ? { payment } : {}), ...(paymentError ? { payment_error: paymentError } : {}) };
  }

  private async payment(orderId: string, accountId: string) {
    const response = await this.request('pollOrderPaymentStatus', { orderId }, accountId);
    return z.object({ data: z.object({ pollOrderPaymentStatus: z.object({ paid: z.boolean().nullable(), paymentStatus: z.number().nullable(), errorType: z.string().nullable() }) }) }).parse(response).data.pollOrderPaymentStatus;
  }

  async paymentStatus(orderId: string, offset: number) {
    const accountId = await new CartService(this.request).accountId();
    const reads = new ConsumerService((operation, variables) => this.request(operation, variables, accountId));
    const result = await reads.orderStatus(orderId, offset);
    if (!result.order) throw new ConsumerError('ORDER_NOT_FOUND_IN_PAGE');
    return this.payment(result.order.orderUuid, accountId);
  }
}

function publicOperation(record: OrderOperation) {
  return { request_id: record.requestId, cart_id: record.cartId, state: record.state, order_uuid: record.orderUuid ?? null,
    created_at: record.createdAt, retry_allowed: false, payment_verified: false,
    recovery: 'Do not call place_order again. Check list_consumer_orders for this purchase; compare time, restaurant, items and pickup/delivery. Follow next_offset if needed. A missing or similar order is not proof of failure or success. Use the exact order UUID for payment/status checks when known. If reads fail, ask the user to check DoorDash history in Chrome. Retain this record; never recreate the cart to bypass it.' };
}
