import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseDoorDashWebhookEnvelope } from '../doordash/webhook-schema.js';
import { Errors, isAppError } from '../errors.js';
import type { AppDeps } from '../http/types.js';

const tokenSchema = z.object({
  grant_type: z.literal('client_credentials'),
  client_id: z.string().optional(), client_secret: z.string().optional(),
});

export function registerWebhookRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.register(async (plugin) => {
    plugin.removeAllContentTypeParsers();
    plugin.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
    plugin.post('/webhooks/doordash/delivery-status', {
      bodyLimit: 65536,
      config: { rawBody: true },
      onRequest: async (request) => {
        if (!(await deps.webhookRateLimiter.consume(request.ip)).allowed) throw Errors.rateLimited();
      },
    }, async (request) => {
      const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      await deps.webhookVerifier.verify({ rawBody, headers: request.headers });
      let payload: unknown;
      try {
        payload = JSON.parse(rawBody.toString('utf8')) as unknown;
      } catch {
        throw Errors.validation('Invalid webhook payload.');
      }
      const receivedAt = new Date();
      const envelope = parseDoorDashWebhookEnvelope(payload, { now: receivedAt });
      const result = await deps.webhookIngestion.ingest(envelope, { requestId: request.id, receivedAt });
      return { status: result.outcome };
    });
  });
  app.register(async (plugin) => {
    if (!plugin.hasContentTypeParser('application/x-www-form-urlencoded')) {
      plugin.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
        const params = new URLSearchParams(String(body));
        if ([...params.keys()].some((key) => params.getAll(key).length !== 1)) return done(Errors.validation());
        done(null, Object.fromEntries(params));
      });
    }
    plugin.post('/webhooks/oauth/token', {
      onRequest: async (_request, reply) => { reply.header('Cache-Control', 'no-store'); },
    }, async (request, reply) => {
      const parsed = tokenSchema.safeParse(request.body);
      if (!parsed.success) throw Errors.validation();
      let clientId = parsed.data.client_id ?? '';
      let clientSecret = parsed.data.client_secret ?? '';
      try {
        if (request.headers.authorization !== undefined) {
          const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(request.headers.authorization);
          if (!match?.[1]) throw Errors.invalidCredentials();
          const credentials = Buffer.from(match[1], 'base64').toString('utf8');
          const separator = credentials.indexOf(':');
          if (separator < 0 || parsed.data.client_id !== undefined || parsed.data.client_secret !== undefined) throw Errors.invalidCredentials();
          try {
            clientId = decodeURIComponent(credentials.slice(0, separator).replace(/\+/g, ' '));
            clientSecret = decodeURIComponent(credentials.slice(separator + 1).replace(/\+/g, ' '));
          } catch {
            throw Errors.invalidCredentials();
          }
        }
        return await deps.webhookTokenIssuer.issue({ clientId, clientSecret });
      } catch (error) {
        if (isAppError(error) && error.code === 'unauthenticated') return reply.code(401).send({ error: 'invalid_client' });
        throw error;
      }
    });
  });
}
