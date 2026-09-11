import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { cartSchema } from '../src/consumer/cart-service.js';

const allowed = new Set(['list_carts', 'get_cart', 'search_restaurants', 'get_restaurant_menu', 'get_menu_item_options', 'add_cart_item',
  'update_cart_item', 'remove_cart_item', 'clear_cart', 'get_checkout_preview', 'get_order_operation', 'list_consumer_orders', 'get_order_payment_status']);
const client = new Client({ name: 'cart-test', version: '0.1.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/cli.js', 'serve'], stderr: 'pipe' });
async function call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  if (!allowed.has(name)) throw new Error('Tool forbidden in live cart test');
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name} failed`);
  const content = z.array(z.object({ type: z.literal('text'), text: z.string() })).parse(result.content);
  console.log(`${name}: passed`);
  return JSON.parse(content[0]!.text) as unknown;
}

let testStore: string | undefined;
let testItem: string | undefined;
let originalCartIds: string[] = [];
try {
  await client.connect(transport);
  const before = z.array(cartSchema).parse(await call('list_carts'));
  originalCartIds = before.map((cart) => cart.id);
  const stores = z.object({ stores: z.array(z.object({ store_id: z.string() })) }).parse(await call('search_restaurants', { query: 'McDonald' })).stores;
  let options: { id: string; quantity: number; options: [] }[] = [];
  for (const store of stores.slice(0, 5)) {
    if (before.some((cart) => cart.restaurant.id === store.store_id)) continue;
    const menu = z.object({ itemLists: z.array(z.object({ items: z.array(z.object({ id: z.string(), name: z.string() })) })) }).parse(await call('get_restaurant_menu', { store_id: store.store_id }));
    const candidates = menu.itemLists.flatMap((group) => group.items).filter((item) => process.argv.includes('--options') ? /^hamburger$/i.test(item.name) : /bottled water/i.test(item.name));
    for (const item of candidates) {
      const detail = z.object({ itemHeader: z.object({ unitAmount: z.number() }), optionLists: z.array(z.object({ minNumOptions: z.number(), options: z.array(z.object({ id: z.string(), unitAmount: z.number(), nestedExtrasList: z.array(z.object({ minNumOptions: z.number() })) })) })) }).parse(await call('get_menu_item_options', { store_id: store.store_id, item_id: item.id }));
      if (detail.itemHeader.unitAmount <= 0 || detail.itemHeader.unitAmount >= 700 || detail.optionLists.some((group) => group.minNumOptions > 0)) continue;
      if (process.argv.includes('--options')) {
        const option = detail.optionLists.flatMap((group) => group.options).find((option) => option.unitAmount === 0 && option.nestedExtrasList.every((group) => group.minNumOptions === 0));
        if (!option) continue;
        options = [{ id: option.id, quantity: 1, options: [] }];
      }
      testStore = store.store_id; testItem = item.id;
      break;
    }
    if (testItem) break;
  }
  if (!testStore || !testItem) throw new Error('No suitable test item');
  const addInput = { store_id: testStore, item_id: testItem, quantity: 1, options };
  const cart = cartSchema.parse(await call('add_cart_item', addInput));
  if (cart.subtotal >= 2000) throw new Error('Test subtotal exceeded limit');
  const item = cart.orders.flatMap((order) => order.orderItems).find((item) => item.item.id === testItem);
  if (!item || (options[0] && !item.nestedOptions?.includes(options[0].id))) throw new Error('Test item/options mismatch');
  await call('get_cart', { cart_id: cart.id });
  const updated = cartSchema.parse(await call('update_cart_item', { cart_id: cart.id, cart_item_id: item.id, quantity: 2 }));
  if (updated.subtotal >= 2000 || updated.orders.flatMap((order) => order.orderItems).find((line) => line.id === item.id)?.quantity !== 2) throw new Error('Quantity/subtotal mismatch');
  await call('get_checkout_preview', { cart_id: cart.id, tip_cents: 0 });
  await call('get_order_operation', { cart_id: cart.id });
  await call('remove_cart_item', { cart_id: cart.id, cart_item_id: item.id });
  const second = cartSchema.parse(await call('add_cart_item', addInput));
  await call('clear_cart', { cart_id: second.id });
  const orders = z.object({ orders: z.array(z.object({ orderUuid: z.string() })) }).parse(await call('list_consumer_orders', { limit: 1 }));
  if (orders.orders[0]) await call('get_order_payment_status', { order_id: orders.orders[0].orderUuid });
} catch (error) {
  console.error(error instanceof Error && error.name !== 'ZodError' ? error.message : 'Live test schema mismatch');
  process.exitCode = 1;
} finally {
  try {
    if (testStore && testItem) {
      const remaining = z.array(cartSchema).parse(await call('list_carts'));
      let cleaned = true;
      for (const cart of remaining) {
        if (originalCartIds.includes(cart.id) || cart.restaurant.id !== testStore) continue;
        if (cart.orders.flatMap((order) => order.orderItems).every((item) => item.item.id === testItem)) await call('clear_cart', { cart_id: cart.id });
        else { console.error('Cart contains other items; manual cleanup needed.'); process.exitCode = 1; cleaned = false; }
      }
      if (cleaned) console.log('Test additions cleaned up. No order-placement tool was called.');
    }
  } catch { console.error('Cleanup could not be verified. Inspect carts manually.'); process.exitCode = 1; }
  await client.close();
}
