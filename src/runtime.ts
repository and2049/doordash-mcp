import { createAuditService } from './audit/service.js';
import { createIdentityProvider } from './auth/factory.js';
import type { AppConfig } from './config/env.js';
import { createDatabase } from './db/factory.js';
import { createRepositories } from './db/repositories/index.js';
import { createWebhookTokenIssuer } from './doordash/webhook-token.js';
import { createWebhookVerifier } from './doordash/webhook-verifier.js';
import { createDeliveryStatusService } from './domain/service.js';
import { buildApp } from './http/server.js';
import type { AppDeps, RuntimeHandle } from './http/types.js';
import type { Logger } from './logging/logger.js';
import { createInMemoryRateLimiter } from './ratelimit/limiter.js';
import { createSecretProvider } from './secrets/factory.js';
import { createWebhookIngestionService } from './webhooks/service.js';

export async function buildRuntime(config: AppConfig, logger: Logger): Promise<RuntimeHandle> {
  const database = await createDatabase(config, logger);
  try {
    const repos = createRepositories(database);
    const secretProvider = createSecretProvider(config);
    const identityProvider = createIdentityProvider({ config, logger });
    const clock = () => new Date();
    const deliveryStatusService = createDeliveryStatusService({
      repos, clock, recentDeliveredWindowHours: config.RECENT_DELIVERED_WINDOW_HOURS,
      freshness: { delayedAfterSeconds: config.STATUS_DELAYED_AFTER_SECONDS, staleAfterSeconds: config.STATUS_STALE_AFTER_SECONDS },
    });
    const auditService = createAuditService({ repo: repos.auditLogs, logger });
    const webhookTokenIssuer = createWebhookTokenIssuer({ config, secretProvider, clock });
    const deps: AppDeps = {
      config, logger, repos, database, secretProvider, identityProvider, deliveryStatusService, auditService, clock,
      toolRateLimiter: createInMemoryRateLimiter({ limitPerMinute: config.RATE_LIMIT_TOOL_PER_MINUTE, clock }),
      webhookRateLimiter: createInMemoryRateLimiter({ limitPerMinute: config.RATE_LIMIT_WEBHOOK_PER_MINUTE, clock }),
      webhookVerifier: createWebhookVerifier({ config, secretProvider, clock, tokenIssuer: webhookTokenIssuer }),
      webhookTokenIssuer,
      webhookIngestion: createWebhookIngestionService({ repos, secretProvider, logger, clock }),
    };
    const app = buildApp(deps);
    return { app, deps, async close() { try { await app.close(); } finally { await database.close(); } } };
  } catch (error) {
    await database.close();
    throw error;
  }
}
