import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config/env.js';
import type { Logger } from '../logging/logger.js';
import type { Database } from '../db/database.js';
import type { Repositories } from '../db/repositories/types.js';
import type { SecretProvider } from '../secrets/secret-provider.js';
import type { IdentityProvider } from '../auth/types.js';
import type { WebhookTokenIssuer, WebhookVerifier } from '../doordash/types.js';
import type { DeliveryStatusService } from '../domain/types.js';
import type { WebhookIngestionService } from '../webhooks/types.js';
import type { RateLimiter } from '../ratelimit/types.js';
import type { AuditService } from '../audit/types.js';

export interface AppDeps {
  config: AppConfig;
  logger: Logger;
  repos: Repositories;
  database?: Database;
  secretProvider: SecretProvider;
  identityProvider: IdentityProvider;
  webhookVerifier: WebhookVerifier;
  webhookTokenIssuer: WebhookTokenIssuer;
  webhookIngestion: WebhookIngestionService;
  deliveryStatusService: DeliveryStatusService;
  toolRateLimiter: RateLimiter;
  webhookRateLimiter: RateLimiter;
  auditService: AuditService;
  clock?: () => Date;
}

export interface RuntimeHandle {
  app: FastifyInstance;
  deps: AppDeps;
  close(): Promise<void>;
}
