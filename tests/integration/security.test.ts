import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { createPgliteDatabase } from '../../src/db/pglite.js';
import { createRepositories } from '../../src/db/repositories/index.js';
import { createDoorDashClient } from '../../src/doordash/client.js';
import { createDoorDashJwtProvider } from '../../src/doordash/jwt.js';
import { toSafeErrorResponse } from '../../src/errors.js';
import { createLogger, REDACT_PATHS } from '../../src/logging/logger.js';
import { seedScenario } from '../support/memory-repositories.js';
import { assertSanitizedToolResult, BASIC_AUTH, connectMcp, createTestRuntime, exerciseRepositories, fixture, FIXTURES, GENERIC_NOT_FOUND, ingestFixture, NOW, postMcp, postWebhook, SIGNING_SECRET, toolParams } from '../support/test-deps.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

async function setup(options: Parameters<typeof createTestRuntime>[0] = {}) {
  const runtime = await createTestRuntime(options);
  cleanup.push(runtime.close);
  return runtime;
}

describe('security boundaries', () => {
  it('redacts Authorization and tokens and never logs or persists generated DoorDash JWTs', async () => {
    const output: string[] = [];
    const logger = pino({ level: 'trace', redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' } }, { write: (chunk: string): void => { output.push(chunk); } });
    const { app, deps, token, scenario } = await setup({ logger });
    const getDoorDashSigningSecret = vi.fn(async (): Promise<string> => SIGNING_SECRET);
    const jwtProvider = createDoorDashJwtProvider({
      config: { DOORDASH_DEVELOPER_ID: 'test-developer', DOORDASH_KEY_ID: 'test-key' },
      secretProvider: { getDoorDashSigningSecret }, clock: () => NOW,
    });
    const jwt = await jwtProvider.getToken();
    expect(jwt.split('.')).toHaveLength(3);
    expect(await jwtProvider.getToken()).toBe(jwt);
    expect(getDoorDashSigningSecret).toHaveBeenCalledExactlyOnceWith(null);
    logger.info({ req: { headers: { authorization: `Bearer ${token}` } }, signingSecret: SIGNING_SECRET, jwt, access_token: token }, 'Representative redacted request.');
    expect((await postWebhook(app, fixture(FIXTURES.pickedUp))).statusCode).toBe(200);
    expect((await postMcp(app, token, 'tools/call', toolParams(scenario.deliveryId))).statusCode).toBe(200);
    const denied = await postMcp(app, token, 'tools/call', toolParams(randomUUID()));
    expect(denied.body).toContain(GENERIC_NOT_FOUND);
    expect((await postMcp(app, 'invalid-private-token', 'tools/list')).statusCode).toBe(401);
    const fetchImpl = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error(`${jwt} ${SIGNING_SECRET} private-network-detail`))
      .mockResolvedValueOnce(Response.json({ delivery_status: 'picked_up', updated_at: NOW.toISOString() }));
    await createDoorDashClient({
      config: { DOORDASH_API_TIMEOUT_MS: 1000, DOORDASH_API_MAX_RETRIES: 1 },
      jwtProvider, logger, fetchImpl, retryBaseDelayMs: 0,
    }).getDelivery(scenario.providerDeliveryId);
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toEqual({ Authorization: `Bearer ${jwt}` });
    const logged = output.join('');
    expect(logged).toContain('[REDACTED]');
    expect(logged).toContain('Webhook processed.');
    expect(logged).toContain('MCP tool invocation failed.');
    expect(logged).toContain('Retrying DoorDash delivery request.');
    const persisted = JSON.stringify(Object.fromEntries(Object.entries(deps.repos.state).map(([name, rows]) => [name, [...rows.values()]])));
    for (const value of [SIGNING_SECRET, jwt, token, BASIC_AUTH, 'invalid-private-token', 'private-network-detail', 'Test Dasher', '+15550100', '1 Test Street', '2 Test Street']) {
      expect(logged).not.toContain(value);
      expect(persisted).not.toContain(value);
    }
    expect(logged).not.toMatch(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    expect(persisted).not.toMatch(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  });

  it.each([FIXTURES.confirmed, FIXTURES.pickedUp, FIXTURES.delivered])('exposes only safe tool fields after %s', async (name) => {
    const { deps, auth, scenario } = await setup();
    await ingestFixture(deps, name);
    const mcp = await connectMcp(deps, auth);
    cleanup.push(mcp.close);
    const result = await mcp.client.callTool({ name: 'get_delivery_status', arguments: { delivery_ref: scenario.deliveryId } });
    expect(result.isError).not.toBe(true);
    assertSanitizedToolResult(result, scenario.providerDeliveryId);
    const serialized = JSON.stringify(result);
    const record = await deps.repos.deliveries.findById(scenario.deliveryId);
    expect(serialized).not.toContain(record?.doordashDeliveryIdHash);
    expect(serialized).not.toMatch(/Test Dasher|Test Street|15550100|tracking_url|sanitized_payload|provider_status/i);
  });

  it('makes missing and unauthorized deliveries byte-identical at both service and MCP boundaries', async () => {
    const { deps, auth } = await setup();
    const other = await seedScenario(deps.repos, { providerDeliveryId: 'private-other-delivery' });
    const refs = [randomUUID(), other.deliveryId];
    const errors: string[] = [];
    for (const delivery_ref of refs) {
      try {
        await deps.deliveryStatusService.getDeliveryStatus(auth, { delivery_ref });
        expect.unreachable('Unauthorized delivery must not be returned.');
      } catch (error) {
        const safe = toSafeErrorResponse(error, 'fixed-request-id');
        expect(safe).toMatchObject({ status: 404, body: { error: { code: 'delivery_not_found_or_unavailable', message: GENERIC_NOT_FOUND } } });
        errors.push(JSON.stringify(safe));
      }
    }
    expect(errors[0]).toBe(errors[1]);
    const mcp = await connectMcp(deps, auth);
    cleanup.push(mcp.close);
    const results: string[] = [];
    for (const delivery_ref of refs) {
      const result = await mcp.client.callTool({ name: 'get_delivery_status', arguments: { delivery_ref } });
      expect(result).toEqual({ isError: true, content: [{ type: 'text', text: GENERIC_NOT_FOUND }] });
      results.push(JSON.stringify(result));
    }
    expect(results[0]).toBe(results[1]);
  });

  it.each(['basic', 'oauth'] as const)('authenticates fixtures in %s mode and fails closed for invalid or missing secrets', async (mode) => {
    const { app, deps } = await setup({ config: { DOORDASH_WEBHOOK_AUTH_MODE: mode, DOORDASH_WEBHOOK_OAUTH_CLIENT_ID: 'webhook-test-client' } });
    let authorization = BASIC_AUTH;
    if (mode === 'oauth') {
      const invalid = await app.inject({ method: 'POST', url: '/webhooks/oauth/token', payload: { grant_type: 'client_credentials', client_id: 'webhook-test-client', client_secret: 'wrong' } });
      expect(invalid.statusCode).toBe(401);
      expect(invalid.json<unknown>()).toEqual({ error: 'invalid_client' });
      const issued = await app.inject({ method: 'POST', url: '/webhooks/oauth/token', payload: { grant_type: 'client_credentials', client_id: 'webhook-test-client', client_secret: 'integration-oauth-secret' } });
      expect(issued.statusCode).toBe(200);
      expect(issued.headers['cache-control']).toBe('no-store');
      const token = issued.json<{ access_token: string; token_type: string }>();
      expect(token.token_type).toBe('Bearer');
      authorization = `Bearer ${token.access_token}`;
    }
    const payload = fixture(FIXTURES.confirmed);
    const invalid = await postWebhook(app, payload, `${authorization}invalid`);
    expect(invalid.statusCode).toBe(401);
    const absent = await postWebhook(app, payload, '');
    expect(absent.statusCode).toBe(401);
    expect(deps.repos.state.events.size).toBe(0);
    const accepted = await postWebhook(app, payload, authorization);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json<unknown>()).toEqual({ status: 'applied' });
    const before = structuredClone(deps.repos.state);
    deps.secretProvider.getWebhookVerificationSecret = async () => null;
    const unconfigured = await postWebhook(app, fixture(FIXTURES.pickedUp), authorization);
    expect(unconfigured.statusCode).toBe(mode === 'basic' ? 503 : 401);
    expect(deps.repos.state).toEqual(before);
    expect(unconfigured.body).not.toContain(authorization);
  });
});

describe('PGlite migration and repository security', () => {
  it('runs migrations twice idempotently and verifies key tables and unique constraints', async () => {
    const db = await createPgliteDatabase({ dataDir: ':memory:' });
    cleanup.push(async () => db.close());
    const logger = createLogger({ level: 'silent' });
    const first = await runMigrations(db, logger);
    expect(first.applied).toContain('0001_init.sql');
    expect(first.skipped).toEqual([]);
    const before = await db.query('SELECT * FROM schema_migrations ORDER BY name');
    const second = await runMigrations(db, logger);
    expect(second).toEqual({ applied: [], skipped: first.applied });
    expect(await db.query('SELECT * FROM schema_migrations ORDER BY name')).toEqual(before);
    const tables = await db.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
    expect(tables.rows.map((row) => row.table_name)).toEqual(expect.arrayContaining(['tenants', 'users', 'doordash_integrations', 'deliveries', 'delivery_access', 'delivery_events', 'audit_logs', 'schema_migrations']));
    const constraints = await db.query<{ table_name: string; definition: string }>("SELECT conrelid::regclass::text AS table_name, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE contype IN ('p', 'u') AND connamespace = 'public'::regnamespace");
    expect(constraints.rows).toEqual(expect.arrayContaining([
      { table_name: 'users', definition: 'UNIQUE (tenant_id, external_subject)' },
      { table_name: 'deliveries', definition: 'UNIQUE (doordash_delivery_id_hash)' },
      { table_name: 'delivery_events', definition: 'UNIQUE (provider_event_id)' },
      { table_name: 'delivery_access', definition: 'PRIMARY KEY (delivery_id, user_id)' },
    ]));
    const repos = createRepositories(db);
    const tenant = await repos.tenants.create({ name: 'PGlite repository contract' });
    await exerciseRepositories(repos, tenant.id);
    expect((await db.query('SELECT metadata FROM audit_logs WHERE tenant_id = $1', [tenant.id])).rows).toEqual([{ metadata: { checked: true } }]);
    await expect(repos.users.create({ tenantId: randomUUID(), externalSubject: 'invalid-tenant' })).rejects.toMatchObject({ code: '23503' });
    await expect(repos.deliveryAccess.create({ deliveryId: randomUUID(), userId: randomUUID(), relationship: 'customer' })).rejects.toMatchObject({ code: '23503' });
  });
});
