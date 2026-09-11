import { randomUUID } from 'node:crypto';
import Fastify, { LogController } from 'fastify';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { resolveAuthContext } from '../auth/context.js';
import { buildWwwAuthenticate, registerAuthRoutes } from '../auth/routes.js';
import type { AuthContext } from '../auth/types.js';
import { Errors, isAppError, toSafeErrorResponse } from '../errors.js';
import { createMcpServer } from '../mcp/server.js';
import { registerWebhookRoutes } from '../webhooks/routes.js';
import type { AppDeps } from './types.js';

export function buildApp(deps: AppDeps): FastifyInstance {
  const logger: FastifyBaseLogger = deps.logger;
  const app = Fastify({
    loggerInstance: logger,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 1_048_576,
    genReqId: (request) => {
      const incoming = request.headers['x-request-id'];
      return typeof incoming === 'string' && incoming.length > 0 ? incoming : randomUUID();
    },
  });
  app.setErrorHandler((error, request, reply) => {
    const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error ? error.statusCode : undefined;
    const safe = toSafeErrorResponse(!isAppError(error) && typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500 ? Errors.validation() : error, request.id);
    deps.logger.error({ requestId: request.id, code: safe.body.error.code }, 'HTTP request failed.');
    if (safe.status === 401 && request.routeOptions.url === '/mcp') {
      reply.header('WWW-Authenticate', buildWwwAuthenticate(`${deps.config.mcpIssuerUrl.replace(/\/+$/, '')}/.well-known/oauth-protected-resource`));
    }
    return reply.code(statusCode === 413 ? 413 : safe.status).send(safe.body);
  });
  app.setNotFoundHandler((request, reply) => reply.code(404).send({
    error: { code: 'validation_error', message: 'Not found.', request_id: request.id },
  }));
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_request, reply) => {
    try {
      await deps.database?.query('select 1');
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
  app.register(async (plugin) => registerAuthRoutes(plugin, deps));
  registerWebhookRoutes(app, deps);
  const contexts = new WeakMap<object, AuthContext>();
  app.post('/mcp', {
    onRequest: async (request) => {
      const match = /^Bearer ([^\s]+)$/i.exec(request.headers.authorization ?? '');
      if (!match?.[1]) throw Errors.unauthenticated();
      const identity = await deps.identityProvider.verifyAccessToken(match[1]).catch(() => { throw Errors.invalidCredentials(); });
      const auth = await resolveAuthContext(deps.repos, identity);
      if (!(await deps.toolRateLimiter.consume(`${auth.tenantId}:${auth.userId}`)).allowed) throw Errors.rateLimited();
      contexts.set(request, auth);
    },
  }, async (request, reply) => {
    const auth = contexts.get(request);
    if (!auth) throw Errors.unauthenticated();
    const server = createMcpServer(deps, auth);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    reply.raw.once('close', () => { void server.close().catch(() => deps.logger.error({ requestId: request.id }, 'MCP cleanup failed.')); });
    reply.hijack();
    try {
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch {
      deps.logger.error({ requestId: request.id }, 'MCP transport failed.');
      if (!reply.raw.headersSent) {
        const safe = toSafeErrorResponse(Errors.internal(), request.id);
        reply.raw.writeHead(safe.status, { 'content-type': 'application/json' });
        reply.raw.end(JSON.stringify(safe.body));
      } else if (!reply.raw.writableEnded) reply.raw.end();
      await server.close();
    }
  });
  app.route({ method: ['GET', 'PUT', 'DELETE'], url: '/mcp', handler: async (_request, reply) => reply.header('Allow', 'POST').code(405).send({ error: 'Method not allowed.' }) });
  return app;
}
