import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ConsumerError, consumerRequest } from './browser-client.js';
import { CartService } from './cart-service.js';
import { OrderOperations } from './order-operations.js';
import type { OrderOperation } from './order-operations.js';
import { ConsumerService } from './service.js';

export type PlaceOrderInput = {
  cart_id: string; request_id: string; preview_hash: string; total_cents: number; tip_cents: number; payment_card_id: string;
};

export class OrderingService {
  constructor(private readonly request: typeof consumerRequest = consumerRequest, private readonly operations = new OrderOperations()) {}

  async place(input: PlaceOrderInput) {
    const carts = new CartService(this.request);
    const accountId = await carts.accountId();
    const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const existing = await this.operations.get(accountId, input.cart_id);
    if (existing) {
      if (existing.requestId !== input.request_id || existing.digest !== digest) throw new ConsumerError('ORDER_OPERATION_CONFLICT');
      return publicOperation(existing);
    }
    const preview = await carts.preview(input.cart_id, input.tip_cents, accountId);
    if (preview.preview_hash !== input.preview_hash || preview.total_cents !== input.total_cents) throw new ConsumerError('CHECKOUT_CHANGED');
    const cart = preview.cart;
    if (cart.hasError || cart.groupCart || cart.containsAlcohol || cart.isMerchantShipping || cart.isPrescriptionDelivery || cart.isBundle || cart.isCatering || cart.fulfillsOwnDeliveries || (cart.merchantTipAmount ?? 0) !== 0) throw new ConsumerError('UNSUPPORTED_CHECKOUT');
    if (!cart.orders.some((order) => order.orderItems.length)) throw new ConsumerError('CART_EMPTY');
    if (!cart.orders.some((order) => order.paymentCard?.id === input.payment_card_id) || !/^\d+$/.test(input.payment_card_id) || !Number.isSafeInteger(Number(input.payment_card_id)) || Number(input.payment_card_id) > 2_147_483_647) throw new ConsumerError('SELECT_PAYMENT_IN_BROWSER');
    const record: OrderOperation = { accountId, cartId: cart.id, requestId: input.request_id, digest, createdAt: new Date().toISOString(), state: 'pending' };
    if (!await this.operations.claim(record)) throw new ConsumerError('ORDER_OPERATION_EXISTS');
    let orderUuid: string | undefined;
    try {
      const response = await this.request('createOrderFromCart', {
        cartId: cart.id, total: input.total_cents, sosDeliveryFee: cart.extraSosDeliveryFee ?? 0,
        isPickupOrder: cart.isConsumerPickup, verifiedAgeRequirement: false, deliveryTime: 'ASAP', storeId: cart.restaurant.id,
        tipAmounts: [{ tipRecipient: 'DASHER', amount: input.tip_cents }], paymentMethod: Number(input.payment_card_id),
        isCardPayment: true, deliveryOptionType: cart.selectedDeliveryOption?.deliveryOptionType ?? 'NOT_SET',
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
    const accountId = await new CartService(this.request).accountId();
    const record = await this.operations.get(accountId, cartId);
    if (!record) return { recorded: false, cart_id: cartId };
    const operation = publicOperation(record);
    if (!record.orderUuid) return { recorded: true, ...operation, recovery: 'Check DoorDash order history before any further purchase. This cart cannot be submitted again by this server.' };
    const payment = await this.payment(record.orderUuid, accountId);
    return { recorded: true, ...operation, payment_verified: payment.paid === true, payment };
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
    created_at: record.createdAt, retry_allowed: false, payment_verified: false };
}
