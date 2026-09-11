import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { FastifyInstance } from 'fastify';
import { createAuditService } from '../../src/audit/service.js';
import { DevIdentityProvider } from '../../src/auth/dev-identity-provider.js';
import type { AuthContext } from '../../src/auth/types.js';
import { loadEnv } from '../../src/config/env.js';
import type { AppConfig } from '../../src/config/env.js';
import type { Repositories } from '../../src/db/repositories/types.js';
import { parseDoorDashWebhookEnvelope } from '../../src/doordash/webhook-schema.js';
import { createWebhookTokenIssuer } from '../../src/doordash/webhook-token.js';
import { createWebhookVerifier } from '../../src/doordash/webhook-verifier.js';
import { createDeliveryStatusService } from '../../src/domain/service.js';
import type { DeliveryProjection, NewDeliveryEvent } from '../../src/domain/types.js';
import { buildApp } from '../../src/http/server.js';
import type { AppDeps } from '../../src/http/types.js';
import { createLogger } from '../../src/logging/logger.js';
import type { Logger } from '../../src/logging/logger.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { createInMemoryRateLimiter } from '../../src/ratelimit/limiter.js';
import type { SecretProvider } from '../../src/secrets/secret-provider.js';
import { createWebhookIngestionService } from '../../src/webhooks/service.js';
import { createMemoryRepositories, seedScenario, TEST_ENCRYPTION_KEY } from './memory-repositories.js';
import type { SeededScenario } from './memory-repositories.js';

export const NOW = new Date('2026-09-10T12:31:00.000Z');
export const BASIC_AUTH = `Basic ${Buffer.from('integration:webhook-secret').toString('base64')}`;
export const SIGNING_SECRET = Buffer.from('integration-signing-secret-32-bytes').toString('base64');
export const GENERIC_NOT_FOUND = 'Delivery not found or not available to this account.';
export const FIXTURES = {
  confirmed: '01-dasher-confirmed.json', arrival: '02-dasher-confirmed-pickup-arrival.json',
  pickedUp: '03-dasher-picked-up.json', delivered: '05-dasher-dropped-off.json',
} as const;

export function fixture(name: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(new URL(`../../fixtures/webhooks/${name}`, import.meta.url), 'utf8'));
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

export function authFor(scenario: SeededScenario): AuthContext {
  return { userId: scenario.userId, tenantId: scenario.tenantId, subject: scenario.subject, scopes: ['deliveries:read'] };
}

export function createTestDeps(options: { config?: Partial<AppConfig>; logger?: Logger; clock?: () => Date } = {}) {
  const config = { ...loadEnv({ NODE_ENV: 'test', PGLITE_DATA_DIR: ':memory:' }), ...options.config };
  const clock = options.clock ?? (() => new Date(NOW));
  const logger = options.logger ?? createLogger({ level: 'silent' });
  const repos = createMemoryRepositories(clock);
  const secretProvider: SecretProvider = {
    async getDatabaseEncryptionKey() { return Buffer.from(TEST_ENCRYPTION_KEY); },
    async getDoorDashSigningSecret() { return SIGNING_SECRET; },
    async getWebhookVerificationSecret() { return config.DOORDASH_WEBHOOK_AUTH_MODE === 'basic' ? BASIC_AUTH : 'integration-oauth-secret'; },
  };
  const identityProvider = new DevIdentityProvider(config, () => clock().getTime());
  const webhookTokenIssuer = createWebhookTokenIssuer({ config, secretProvider, clock });
  const deps = {
    config, logger, repos, secretProvider, identityProvider, webhookTokenIssuer, clock,
    auditService: createAuditService({ repo: repos.auditLogs, logger }),
    webhookVerifier: createWebhookVerifier({ config, secretProvider, clock, tokenIssuer: webhookTokenIssuer }),
    webhookIngestion: createWebhookIngestionService({ repos, secretProvider, logger, clock }),
    deliveryStatusService: createDeliveryStatusService({
      repos, clock, recentDeliveredWindowHours: config.RECENT_DELIVERED_WINDOW_HOURS,
      freshness: { delayedAfterSeconds: config.STATUS_DELAYED_AFTER_SECONDS, staleAfterSeconds: config.STATUS_STALE_AFTER_SECONDS },
    }),
    toolRateLimiter: createInMemoryRateLimiter({ limitPerMinute: config.RATE_LIMIT_TOOL_PER_MINUTE, clock }),
    webhookRateLimiter: createInMemoryRateLimiter({ limitPerMinute: config.RATE_LIMIT_WEBHOOK_PER_MINUTE, clock }),
  } satisfies AppDeps;
  return deps;
}

export async function createTestRuntime(options: Parameters<typeof createTestDeps>[0] = {}) {
  const deps = createTestDeps(options);
  const scenario = await seedScenario(deps.repos);
  const auth = authFor(scenario);
  const { access_token: token } = await deps.identityProvider.issueTokenForTesting({ subject: auth.subject, tenantRef: auth.tenantId, scopes: auth.scopes });
  const app = buildApp(deps);
  return { deps, scenario, auth, token, app, close: async (): Promise<void> => { await app.close(); } };
}

export async function connectMcp(deps: AppDeps, auth: AuthContext) {
  const server = createMcpServer(deps, auth);
  const client = new Client({ name: 'integration-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  } catch (error) {
    await Promise.all([client.close(), server.close()]);
    throw error;
  }
  return { client, close: async (): Promise<void> => { await Promise.all([client.close(), server.close()]); } };
}

export async function postMcp(app: FastifyInstance, token: string | undefined, method: string, params?: Record<string, unknown>) {
  return app.inject({
    method: 'POST', url: '/mcp',
    headers: { accept: 'application/json, text/event-stream', ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
    payload: { jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) },
  });
}

export function toolParams(deliveryRef: string): Record<string, unknown> {
  return { name: 'get_delivery_status', arguments: { delivery_ref: deliveryRef } };
}

export async function postWebhook(app: FastifyInstance, payload: Record<string, unknown>, authorization = BASIC_AUTH) {
  return app.inject({ method: 'POST', url: '/webhooks/doordash/delivery-status', headers: { authorization, 'content-type': 'application/json' }, payload });
}

export async function ingestFixture(deps: AppDeps, name: string) {
  return deps.webhookIngestion.ingest(parseDoorDashWebhookEnvelope(fixture(name)), { requestId: randomUUID(), receivedAt: deps.clock?.() ?? NOW });
}

export function assertSanitizedToolResult(result: unknown, providerId: string): void {
  const serialized = JSON.stringify(result);
  assert(!/secret|token|authorization|phone|address|lat|lng|dasher/i.test(serialized));
  assert(!serialized.includes(providerId));
  const scan = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value)) {
      assert(!/driver|provider|coordinate|location/i.test(key));
      if (key === 'text' && typeof nested === 'string') {
        assert(!/driver/i.test(nested.replace(/"status":"driver_assigned"/g, '')));
      } else if (typeof nested === 'string' && key !== 'status') assert(!/driver/i.test(nested));
      scan(nested);
    }
  };
  scan(result);
}

export async function exerciseRepositories(repos: Repositories, tenantId: string): Promise<void> {
  const tenant = await repos.tenants.ensure({ id: tenantId, name: 'Repository contract' });
  assert.deepEqual(await repos.tenants.ensure({ id: tenantId, name: 'Must not overwrite' }), tenant);
  assert.deepEqual(await repos.tenants.findById(tenantId), tenant);
  assert.equal(await repos.tenants.findById(randomUUID()), null);
  const user = await repos.users.create({ tenantId, externalSubject: randomUUID(), displayName: 'Original' });
  assert.deepEqual(await repos.users.ensure({ tenantId, externalSubject: user.externalSubject, displayName: 'Changed' }), user);
  assert.deepEqual(await repos.users.findById(user.id), user);
  assert.deepEqual(await repos.users.findByExternalSubject(tenantId, user.externalSubject), user);
  const other = await repos.users.ensure({ tenantId, externalSubject: randomUUID() });
  assert.equal(other.displayName, null);
  const concurrentSubject = randomUUID();
  const ensured = await Promise.all(Array.from({ length: 3 }, () => repos.users.ensure({ tenantId, externalSubject: concurrentSubject })));
  assert.equal(new Set(ensured.map((row) => row.id)).size, 1);
  assert.equal(await repos.users.findById(randomUUID()), null);
  assert.equal(await repos.users.findByExternalSubject(randomUUID(), user.externalSubject), null);
  await assert.rejects(repos.users.create({ tenantId, externalSubject: user.externalSubject }), { code: '23505' });
  const integration = await repos.integrations.create({ tenantId, environment: 'sandbox' });
  assert.deepEqual(await repos.integrations.findActiveByTenantId(tenantId), integration);
  await repos.integrations.setStatus(integration.id, 'disabled');
  assert.equal(await repos.integrations.findActiveByTenantId(tenantId), null);
  await repos.integrations.setStatus(integration.id, 'active');
  assert.equal((await repos.integrations.findActiveByTenantId(tenantId))?.status, 'active');
  const delivery = await repos.deliveries.create({ tenantId, doordashDeliveryIdHash: randomUUID() });
  assert.equal(delivery.status, 'unknown');
  assert.equal(delivery.lastEventAt, null);
  assert.deepEqual(await repos.deliveries.findById(delivery.id), delivery);
  assert.deepEqual(await repos.deliveries.findByDoordashDeliveryIdHash(delivery.doordashDeliveryIdHash), delivery);
  assert.equal(await repos.deliveries.findById(randomUUID()), null);
  assert.equal(await repos.deliveries.findByDoordashDeliveryIdHash(randomUUID()), null);
  await assert.rejects(repos.deliveries.create({ tenantId, doordashDeliveryIdHash: delivery.doordashDeliveryIdHash }), { code: '23505' });
  assert.equal(await repos.deliveries.findAccessibleForUser(delivery.id, user.id), null);
  const access = await repos.deliveryAccess.create({ deliveryId: delivery.id, userId: user.id, relationship: 'customer' });
  assert.deepEqual(await repos.deliveryAccess.find(delivery.id, user.id), access);
  assert.deepEqual(await repos.deliveries.findAccessibleForUser(delivery.id, user.id), delivery);
  assert.equal(await repos.deliveryAccess.find(delivery.id, other.id), null);
  assert.equal(await repos.deliveries.findAccessibleForUser(delivery.id, other.id), null);
  await assert.rejects(repos.deliveryAccess.create({ deliveryId: delivery.id, userId: user.id, relationship: 'operator' }), { code: '23505' });
  const projection: DeliveryProjection = { status: 'picked_up', providerStatus: 'DASHER_PICKED_UP', etaAt: new Date(NOW.getTime() + 60_000), lastEventAt: NOW };
  assert.deepEqual(await repos.deliveries.applyEventProjection({ deliveryId: delivery.id, expectedLastEventAt: new Date(0), projection, receivedAt: NOW }), { updated: false });
  assert.deepEqual(await repos.deliveries.findById(delivery.id), delivery);
  assert.deepEqual(await repos.deliveries.applyEventProjection({ deliveryId: delivery.id, expectedLastEventAt: null, projection, receivedAt: NOW }), { updated: true });
  const projected = await repos.deliveries.findById(delivery.id);
  assert(projected);
  for (const key of ['status', 'providerStatus', 'etaAt', 'lastEventAt'] as const) assert.deepEqual(projected[key], projection[key]);
  assert.deepEqual(projected.lastReceivedAt, NOW);
  assert.deepEqual(await repos.deliveries.applyEventProjection({ deliveryId: delivery.id, expectedLastEventAt: null, projection: { ...projection, status: 'cancelled' }, receivedAt: NOW }), { updated: false });
  assert.deepEqual(await repos.deliveries.findById(delivery.id), projected);
  assert.deepEqual(await repos.deliveries.applyEventProjection({ deliveryId: delivery.id, expectedLastEventAt: new Date(NOW.getTime() - 1), projection: { ...projection, status: 'cancelled' }, receivedAt: NOW }), { updated: false });
  assert.deepEqual(await repos.deliveries.findById(delivery.id), projected);
  assert.deepEqual(await repos.deliveries.applyEventProjection({ deliveryId: delivery.id, expectedLastEventAt: new Date(NOW), projection, receivedAt: NOW }), { updated: true });
  assert.deepEqual(await repos.deliveries.applyEventProjection({ deliveryId: randomUUID(), expectedLastEventAt: null, projection, receivedAt: NOW }), { updated: false });
  const receivedAt = new Date(NOW.getTime() + 1000);
  await repos.deliveries.touchLastReceived(delivery.id, receivedAt);
  assert.deepEqual((await repos.deliveries.findById(delivery.id))?.lastReceivedAt, receivedAt);
  assert.deepEqual((await repos.deliveries.findById(delivery.id))?.lastEventAt, NOW);
  const event: NewDeliveryEvent = { deliveryId: delivery.id, providerEventId: randomUUID(), eventType: 'DASHER_PICKED_UP', providerStatus: 'DASHER_PICKED_UP', normalizedStatus: 'picked_up', occurredAt: NOW, receivedAt, sanitizedPayload: { contactless: true } };
  const inserted = await repos.deliveryEvents.insertIfAbsent(event);
  assert.equal(inserted.inserted, true);
  assert.deepEqual(await repos.deliveryEvents.insertIfAbsent({ ...event, normalizedStatus: 'cancelled' }), { inserted: false, event: inserted.event });
  const older = await repos.deliveryEvents.insertIfAbsent({ ...event, providerEventId: randomUUID(), occurredAt: new Date(0) });
  assert.deepEqual(await repos.deliveryEvents.listByDelivery(delivery.id), [inserted.event, older.event]);
  assert.deepEqual(await repos.deliveryEvents.listByDelivery(delivery.id, { limit: 1 }), [inserted.event]);
  assert.deepEqual(await repos.deliveryEvents.listByDelivery(randomUUID()), []);
  const cutoff = new Date(NOW.getTime() - 24 * 3_600_000);
  const terminalIds: string[] = [];
  for (const status of ['delivered', 'cancelled'] as const) {
    const terminal = await repos.deliveries.create({ tenantId, doordashDeliveryIdHash: randomUUID(), status });
    await repos.deliveryAccess.create({ deliveryId: terminal.id, userId: user.id, relationship: 'support' });
    await repos.deliveries.touchLastReceived(terminal.id, cutoff);
    terminalIds.push(terminal.id);
  }
  assert.deepEqual((await repos.deliveries.listAccessibleForUser(user.id)).map((row) => row.id), [delivery.id]);
  assert.deepEqual((await repos.deliveries.listAccessibleForUser(user.id, { includeRecentDelivered: true, now: NOW })).map((row) => row.id), [delivery.id, ...terminalIds.sort()]);
  assert.deepEqual((await repos.deliveries.listAccessibleForUser(user.id, { includeRecentDelivered: true, recentWindowHours: 1, now: NOW })).map((row) => row.id), [delivery.id]);
  await repos.deliveries.touchLastReceived(terminalIds[0]!, new Date(cutoff.getTime() - 1));
  assert.equal((await repos.deliveries.listAccessibleForUser(user.id, { includeRecentDelivered: true, now: NOW })).length, 2);
  assert.deepEqual(await repos.deliveries.listAccessibleForUser(other.id), []);
  assert.equal((await repos.deliveries.listAccessibleForUser(user.id, { includeRecentDelivered: true, now: NOW, limit: 1 })).length, 1);
  assert.deepEqual(await repos.deliveries.listAccessibleForUser(user.id, { limit: 0 }), []);
  await repos.auditLogs.insert({ tenantId, userId: user.id, deliveryId: delivery.id, action: 'repository.contract', outcome: 'success', requestId: randomUUID(), metadata: { checked: true } });
}
