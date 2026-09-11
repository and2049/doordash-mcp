import { CallToolResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { seedScenario } from '../support/memory-repositories.js';
import { assertSanitizedToolResult, connectMcp, createTestRuntime, fixture, FIXTURES, GENERIC_NOT_FOUND, ingestFixture, postMcp, postWebhook, toolParams } from '../support/test-deps.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function setup(options: Parameters<typeof createTestRuntime>[0] = {}) {
  const runtime = await createTestRuntime(options);
  cleanup.push(runtime.close);
  return runtime;
}

describe('HTTP and real MCP server', () => {
  it('challenges unauthenticated requests with resource metadata', async () => {
    const { app } = await setup();
    const response = await postMcp(app, undefined, 'tools/list');
    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toContain('resource_metadata=');
    expect(response.headers['www-authenticate']).toContain('/.well-known/oauth-protected-resource');
  });

  it('lists exactly one read-only tool with the required delivery_ref string schema', async () => {
    const { app, token } = await setup();
    const response = await postMcp(app, token, 'tools/list');
    expect(response.statusCode).toBe(200);
    const { tools } = ListToolsResultSchema.parse(response.json<{ result: unknown }>().result);
    expect(tools.map((tool) => tool.name)).toEqual(['get_delivery_status']);
    expect(tools[0]?.inputSchema).toMatchObject({ type: 'object', properties: { delivery_ref: { type: 'string', minLength: 1 } }, required: ['delivery_ref'] });
    expect(Object.keys(tools[0]?.inputSchema.properties ?? {})).toEqual(['delivery_ref']);
    expect(tools[0]?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });

  it('returns the authorized snake_case payload without sensitive provider data', async () => {
    const { app, token, deps, scenario } = await setup();
    await ingestFixture(deps, FIXTURES.pickedUp);
    const response = await postMcp(app, token, 'tools/call', toolParams(scenario.deliveryId));
    expect(response.statusCode).toBe(200);
    const result = CallToolResultSchema.parse(response.json<{ result: unknown }>().result);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ delivery_ref: scenario.deliveryId, merchant_name: 'Test Kitchen', status: 'picked_up', is_terminal: false, data_freshness: 'stale' });
    expect(Object.keys(result.structuredContent ?? {}).sort()).toEqual(['data_freshness', 'delivery_ref', 'eta_at', 'eta_minutes', 'is_terminal', 'last_updated_at', 'merchant_name', 'status', 'summary']);
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.structuredContent) }]);
    assertSanitizedToolResult(result, scenario.providerDeliveryId);
  });

  it.each(['same tenant', 'other tenant'])('uses the generic tool error for another user in %s', async (kind) => {
    const { app, token, deps, scenario } = await setup();
    const other = await seedScenario(deps.repos, { providerDeliveryId: `other-${kind}`, ...(kind === 'same tenant' ? { tenantId: scenario.tenantId } : {}) });
    const response = await postMcp(app, token, 'tools/call', toolParams(other.deliveryId));
    expect(response.statusCode).toBe(200);
    expect(CallToolResultSchema.parse(response.json<{ result: unknown }>().result)).toEqual({ isError: true, content: [{ type: 'text', text: GENERIC_NOT_FOUND }] });
  });

  it('denies a valid token without deliveries:read at tool level with no data', async () => {
    const { app, deps, scenario } = await setup();
    const { access_token: token } = await deps.identityProvider.issueTokenForTesting({ subject: scenario.subject, tenantRef: scenario.tenantId, scopes: ['deliveries:list'] });
    const response = await postMcp(app, token, 'tools/call', toolParams(scenario.deliveryId));
    expect(response.statusCode).toBe(200);
    expect(CallToolResultSchema.parse(response.json<{ result: unknown }>().result)).toEqual({ isError: true, content: [{ type: 'text', text: 'You do not have permission to perform this operation.' }] });
    expect([...deps.repos.state.audits.values()].at(-1)?.outcome).toBe('denied');
  });

  it('returns HTTP 429 when the configured tool limit is exhausted', async () => {
    const { app, token, scenario, deps } = await setup({ config: { RATE_LIMIT_TOOL_PER_MINUTE: 1 } });
    expect((await postMcp(app, token, 'tools/call', toolParams(scenario.deliveryId))).statusCode).toBe(200);
    const response = await postMcp(app, token, 'tools/call', toolParams(scenario.deliveryId));
    expect(response.statusCode).toBe(429);
    expect(response.json<unknown>()).toMatchObject({ error: { code: 'rate_limited' } });
    expect(deps.repos.state.audits.size).toBe(1);
  });

  it('authenticates real HTTP webhooks and acknowledges replayed duplicates', async () => {
    const { app, deps, scenario } = await setup();
    const payload = fixture(FIXTURES.confirmed);
    expect((await postWebhook(app, payload, 'Basic wrong')).statusCode).toBe(401);
    expect(deps.repos.state.events.size).toBe(0);
    expect((await deps.repos.deliveries.findById(scenario.deliveryId))?.status).toBe('scheduled');
    const first = await postWebhook(app, payload);
    expect(first.statusCode).toBe(200);
    expect(first.json<unknown>()).toEqual({ status: 'applied' });
    const duplicate = await postWebhook(app, payload);
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json<unknown>()).toEqual({ status: 'duplicate' });
    expect(deps.repos.state.events.size).toBe(1);
    expect((await deps.repos.deliveries.findById(scenario.deliveryId))?.status).toBe('driver_assigned');
  });

  it('supports SDK initialization, tools/list and tools/call over linked in-memory transports', async () => {
    const { deps, auth, scenario } = await setup();
    await ingestFixture(deps, FIXTURES.delivered);
    const mcp = await connectMcp(deps, auth);
    cleanup.push(mcp.close);
    expect((await mcp.client.listTools()).tools.map((tool) => tool.name)).toEqual(['get_delivery_status']);
    const result = await mcp.client.callTool({ name: 'get_delivery_status', arguments: { delivery_ref: scenario.deliveryId } });
    expect(result).toMatchObject({ structuredContent: { status: 'delivered', is_terminal: true, data_freshness: 'fresh' } });
    assertSanitizedToolResult(result, scenario.providerDeliveryId);
  });
});
