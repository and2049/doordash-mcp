import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createAuditService } from '../../../src/audit/service.js';
import { SCOPES } from '../../../src/auth/types.js';
import { loadEnv } from '../../../src/config/env.js';
import type { Database } from '../../../src/db/database.js';
import { createRepositories } from '../../../src/db/repositories/index.js';
import { Errors } from '../../../src/errors.js';
import { buildApp } from '../../../src/http/server.js';
import type { AppDeps } from '../../../src/http/types.js';
import { createLogger } from '../../../src/logging/logger.js';
import { createInMemoryRateLimiter } from '../../../src/ratelimit/limiter.js';

const apps: FastifyInstance[] = [];
const now = new Date('2026-09-10T12:00:00Z');

function setup(): { app: FastifyInstance; deps: AppDeps } {
  const config = loadEnv({ NODE_ENV: 'test' });
  const logger = createLogger({ level: 'silent' });
  const database: Database = {
    async query() { throw new Error('Unexpected database query'); },
    async withTransaction(fn) { return fn(database); },
    async close() {},
  };
  const repos = createRepositories(database);
  repos.tenants.findById = async () => ({ id: config.DEV_TENANT_ID, name: 'Test', createdAt: now });
  repos.users.findByExternalSubject = async () => ({ id: 'user', tenantId: config.DEV_TENANT_ID, externalSubject: 'subject', displayName: null, createdAt: now });
  const deps: AppDeps = {
    config, logger, repos,
    secretProvider: {
      async getDatabaseEncryptionKey() { return null; },
      async getDoorDashSigningSecret() { return null; },
      async getWebhookVerificationSecret() { return null; },
    },
    identityProvider: {
      kind: 'dev', issuer: config.mcpIssuerUrl,
      async authorizationUrl() { return 'http://localhost/'; },
      async exchangeCode() { throw Errors.invalidCredentials(); },
      async verifyAccessToken(token) {
        if (token !== 'dev-token') throw Errors.invalidCredentials();
        return { subject: 'subject', tenantRef: config.DEV_TENANT_ID, scopes: [SCOPES.deliveriesRead] };
      },
    },
    webhookVerifier: { verify: vi.fn(async () => { throw Errors.invalidCredentials(); }) },
    webhookTokenIssuer: {
      async issue() { throw Errors.invalidCredentials(); },
      async verify() { throw Errors.invalidCredentials(); },
    },
    webhookIngestion: { ingest: vi.fn(async () => ({ outcome: 'ignored' as const })) },
    deliveryStatusService: {
      getDeliveryStatus: vi.fn(async (_auth, input) => ({
        delivery_ref: input.delivery_ref, merchant_name: null, status: 'scheduled' as const,
        summary: 'Scheduled.', eta_at: null, eta_minutes: null, last_updated_at: now.toISOString(),
        is_terminal: false, data_freshness: 'fresh' as const,
      })),
      async listActiveDeliveries() { return { deliveries: [] }; },
    },
    toolRateLimiter: createInMemoryRateLimiter({ limitPerMinute: 60 }),
    webhookRateLimiter: createInMemoryRateLimiter({ limitPerMinute: 600 }),
    auditService: { record: vi.fn(async () => {}) },
  };
  const app = buildApp(deps);
  apps.push(app);
  return { app, deps };
}

afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe('HTTP integration smoke tests', () => {
  it('serves health and OAuth resource discovery', async () => {
    const { app } = setup();
    expect((await app.inject({ url: '/healthz' })).json()).toEqual({ status: 'ok' });
    expect((await app.inject({ url: '/healthz' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/.well-known/oauth-protected-resource' })).statusCode).toBe(200);
  });

  it('requires a bearer token and advertises OAuth metadata', async () => {
    const { app } = setup();
    const response = await app.inject({ method: 'POST', url: '/mcp', payload: {} });
    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toContain('/.well-known/oauth-protected-resource');
  });

  it('reaches the one read-only MCP tool with a valid identity', async () => {
    const { app, deps } = setup();
    const response = await app.inject({
      method: 'POST', url: '/mcp',
      headers: { authorization: 'Bearer dev-token', accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_delivery_status', arguments: { delivery_ref: 'delivery' } } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ result: { structuredContent: { delivery_ref: 'delivery', status: 'scheduled' } } });
    expect(deps.deliveryStatusService.getDeliveryStatus).toHaveBeenCalledOnce();
    expect(deps.auditService.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'mcp.get_delivery_status', outcome: 'success' }));
  });

  it('rejects bad webhook authentication before parsing and preserves raw bytes', async () => {
    const { app, deps } = setup();
    const payload = '{ "private": "value"';
    const response = await app.inject({ method: 'POST', url: '/webhooks/doordash/delivery-status', headers: { 'content-type': 'application/json' }, payload });
    expect(response.statusCode).toBe(401);
    expect(deps.webhookVerifier.verify).toHaveBeenCalledWith(expect.objectContaining({ rawBody: Buffer.from(payload) }));
    expect(deps.webhookIngestion.ingest).not.toHaveBeenCalled();
    expect(response.body).not.toContain('private');
  });

  it('rejects authenticated malformed webhook bodies safely', async () => {
    const { app, deps } = setup();
    deps.webhookVerifier.verify = vi.fn(async () => {});
    const response = await app.inject({ method: 'POST', url: '/webhooks/doordash/delivery-status', headers: { 'content-type': 'application/json' }, payload: '{' });
    expect(response.statusCode).toBe(400);
    expect(deps.webhookIngestion.ingest).not.toHaveBeenCalled();
  });

  it('returns a generic 404 and preserves the request id', async () => {
    const { app } = setup();
    const response = await app.inject({ url: '/unknown', headers: { 'x-request-id': 'request-123' } });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: 'validation_error', message: 'Not found.', request_id: 'request-123' } });
  });

  it('returns uncached invalid_client for bad webhook OAuth credentials', async () => {
    const { app } = setup();
    const response = await app.inject({ method: 'POST', url: '/webhooks/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'grant_type=client_credentials&client_id=bad&client_secret=private' });
    expect(response.statusCode).toBe(401);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ error: 'invalid_client' });
  });

  it('denies excess cost without consuming capacity and resets expired windows', async () => {
    let milliseconds = now.getTime();
    const limiter = createInMemoryRateLimiter({ limitPerMinute: 2, clock: () => new Date(milliseconds) });
    expect(await limiter.consume('user')).toMatchObject({ allowed: true, remaining: 1 });
    expect(await limiter.consume('user', 2)).toMatchObject({ allowed: false, remaining: 1 });
    expect(await limiter.consume('other', 2)).toMatchObject({ allowed: true, remaining: 0 });
    milliseconds += 60_000;
    expect(await limiter.consume('user', 2)).toMatchObject({ allowed: true, remaining: 0 });
  });

  it('sanitizes audit metadata and contains repository failures', async () => {
    const insert = vi.fn(async () => { throw new Error('private database error'); });
    const audit = createAuditService({ repo: { insert }, logger: createLogger({ level: 'silent' }) });
    await expect(audit.record({ tenantId: 'tenant', userId: null, deliveryId: null, requestId: 'request', action: 'test', outcome: 'success', metadata: { token: 'private', nested: { address: 'private' } } })).resolves.toBeUndefined();
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ metadata: { token: '[REDACTED]', nested: { address: '[REDACTED]' } } }));
  });
});
