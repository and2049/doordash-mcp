import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';

const client = new Client({ name: 'consumer-read-verification', version: '0.1.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/cli.js', 'serve'], stderr: 'pipe' });
async function call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name} failed`);
  const content = z.array(z.object({ type: z.literal('text'), text: z.string() })).parse(result.content);
  const data = JSON.parse(content[0]!.text) as unknown;
  console.log(`${name}: passed`);
  return data;
}
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  if (!tools.find((tool) => tool.name === 'get_consumer_account_status')?.annotations?.readOnlyHint) throw new Error('Unexpected tool set');
  z.object({ account_verified: z.literal(true) }).parse(await call('get_consumer_account_status'));
  const orders = z.object({ orders: z.array(z.object({ orderUuid: z.string() })) }).parse(await call('list_consumer_orders', { limit: 2 }));
  if (orders.orders[0]) z.object({ found: z.literal(true) }).parse(await call('get_consumer_order_status', { order_id: orders.orders[0].orderUuid }));
  else console.log('get_consumer_order_status: skipped (no orders)');
  const search = z.object({ stores: z.array(z.object({ store_id: z.string() })) }).parse(await call('search_restaurants', { query: 'pizza' }));
  const store = search.stores[0];
  if (store) {
    const menu = z.object({ itemLists: z.array(z.object({ items: z.array(z.object({ id: z.string() })) })) }).parse(await call('get_restaurant_menu', { store_id: store.store_id }));
    const item = menu.itemLists.flatMap((category) => category.items)[0];
    if (item) await call('get_menu_item_options', { store_id: store.store_id, item_id: item.id });
    else console.log('get_menu_item_options: skipped (no loaded items)');
  } else console.log('Menu/options: skipped (no restaurant matches)');
} catch {
  console.error('Consumer read verification failed. Run consumer:verify to check connection; build before running this script.');
  process.exitCode = 1;
} finally { await client.close(); }
