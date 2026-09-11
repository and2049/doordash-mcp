import { z } from 'zod';
import { ConsumerError, consumerRequest } from './browser-client.js';

const text = z.string().max(20_000);
const id = z.string().min(1).max(100);
const money = z.object({ unitAmount: z.number(), currency: text, decimalPlaces: z.number(), displayString: text });
const orderSchema = z.object({
  id, orderUuid: id, createdAt: text.nullable(), submittedAt: text.nullable(), cancelledAt: text.nullable(), fulfilledAt: text.nullable(),
  isPickup: z.boolean(), store: z.object({ id, name: text }), grandTotal: money,
  orders: z.array(z.object({ items: z.array(z.object({ id, name: text, quantity: z.number() })) })),
});
const searchSchema = z.object({ body: z.array(z.object({ body: z.array(z.object({
  text: z.object({ title: text.nullable(), subtitle: text.nullable(), description: text.nullable() }).nullable(),
  events: z.object({ click: z.object({ data: text.nullable() }).nullable() }).nullable(),
})) })) });
const menuSchema = z.object({
  storeHeader: z.object({ id, name: text, description: text.nullable(), currency: text, offersDelivery: z.boolean(), offersPickup: z.boolean(),
    asapMinutes: z.number().nullable(), ratings: z.object({ averageRating: z.number(), numRatingsDisplayString: text }).nullable() }),
  menuBook: z.object({ id, name: text, menuCategories: z.array(z.object({ id, name: text, numItems: z.number() })),
    menuList: z.array(z.object({ id, name: text, displayOpenHours: text })) }),
  itemLists: z.array(z.object({ id, name: text, items: z.array(z.object({ id, name: text, description: text.nullable(), displayPrice: text })) })),
});
const option = z.object({ id, name: text, unitAmount: z.number(), displayString: text });
const group = z.object({ name: text, isOptional: z.boolean(), minNumOptions: z.number(), maxNumOptions: z.number() });
const itemSchema = z.object({
  itemHeader: z.object({ name: text, description: text.nullable(), unitAmount: z.number(), quantityLimit: z.number().nullable() }),
  optionLists: z.array(group.extend({ options: z.array(option.extend({ nestedExtrasList: z.array(group.extend({ options: z.array(option) })) })) })),
});

export function parseSearch(value: unknown): { store_id: string; name: string; subtitle: string | null; description: string | null }[] {
  const feed = searchSchema.parse(value);
  const stores = new Map<string, { store_id: string; name: string; subtitle: string | null; description: string | null }>();
  for (const section of feed.body) for (const item of section.body) {
    if (!item.text?.title || !item.events?.click?.data) continue;
    let data: unknown;
    try { data = JSON.parse(item.events.click.data) as unknown; } catch { continue; }
    if (!data || typeof data !== 'object' || !('uri' in data) || typeof data.uri !== 'string') continue;
    const storeId = /(?:^|\/)store\/(\d+)(?:[/?#]|$)/.exec(data.uri)?.[1];
    if (storeId) stores.set(storeId, { store_id: storeId, name: item.text.title, subtitle: item.text.subtitle, description: item.text.description });
  }
  return [...stores.values()];
}

export function parseOrders(value: unknown) {
  return z.array(orderSchema).parse(value).map((order) => ({
    ...order,
    status: order.cancelledAt ? 'cancelled' : order.fulfilledAt ? 'fulfilled' : order.submittedAt ? 'submitted' : 'unknown',
    status_source: 'order_history_timestamps',
  }));
}

export class ConsumerService {
  constructor(private readonly request: typeof consumerRequest = consumerRequest) {}

  private async query(operation: Exclude<Parameters<typeof consumerRequest>[0], 'account'>, variables: Record<string, unknown>): Promise<unknown> {
    const response = z.object({ data: z.record(z.string(), z.unknown()) }).parse(await this.request(operation, variables));
    if (!(operation in response.data) || response.data[operation] === null) throw new ConsumerError('PROVIDER_DATA_UNAVAILABLE');
    return response.data[operation];
  }

  async accountStatus() {
    const account = z.object({ consumer_id: id, profile_status: text }).parse(await this.request('account'));
    return { account_verified: true, account_id: account.consumer_id, profile_status: account.profile_status, checked_at: new Date().toISOString(), transport: 'chrome_cdp' };
  }

  async listOrders(offset: number, limit: number) {
    const orders = parseOrders(await this.query('getConsumerOrdersWithDetails', { offset, limit, includeCancelled: true }));
    return { orders, offset, next_offset: orders.length === limit ? offset + limit : null, checked_at: new Date().toISOString() };
  }

  async orderStatus(orderId: string, offset: number) {
    const page = await this.listOrders(offset, 20);
    const order = page.orders.find((order) => order.id === orderId || order.orderUuid === orderId);
    return { order: order ?? null, found: !!order, searched_offset: offset, next_offset: page.next_offset,
      checked_at: page.checked_at, note: 'History-derived status only; no courier location or live delivery ETA. If absent, use next_offset to search older history.' };
  }

  async search(query: string, limit: number) {
    const stores = parseSearch(await this.query('autocompleteFacetFeed', { query }));
    return { stores: stores.slice(0, limit), source: 'restaurant_autocomplete', truncated: stores.length > limit,
      location_context: 'Current DoorDash browser delivery location', exhaustive: false };
  }

  async menu(storeId: string) {
    const menu = menuSchema.parse(await this.query('storepageFeed', { storeId, isMerchantPreview: false }));
    return { ...menu, complete: false, note: 'Current default menu feed; categories may be partially loaded. Prices and availability are not a checkout quote.' };
  }

  async itemOptions(storeId: string, itemId: string, fulfillmentType: 'DELIVERY' | 'PICKUP') {
    const item = itemSchema.parse(await this.query('itemPage', { storeId, itemId, fulfillmentType: fulfillmentType === 'DELIVERY' ? 'Delivery' : 'Pickup' }));
    return { store_id: storeId, item_id: itemId, ...item, nested_option_depth: 1,
      note: 'Includes one nested customization level. Constraints are provider values; prices are not a checkout quote.' };
  }
}
