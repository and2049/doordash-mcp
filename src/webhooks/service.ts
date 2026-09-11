import { createAuditService } from '../audit/service.js';
import { hashProviderId } from '../crypto/field-crypto.js';
import type { Repositories } from '../db/repositories/types.js';
import { normalizeDoorDashEvent } from '../domain/normalize.js';
import { decideTransition } from '../domain/transitions.js';
import type { Logger } from '../logging/logger.js';
import { sanitizeAuditMetadata } from '../logging/redact.js';
import type { SecretProvider } from '../secrets/secret-provider.js';
import type { WebhookIngestionService, WebhookOutcome } from './types.js';

export function createWebhookIngestionService(deps: {
  repos: Repositories; secretProvider: SecretProvider; logger: Logger; clock?: () => Date;
}): WebhookIngestionService {
  const audit = createAuditService({ repo: deps.repos.auditLogs, logger: deps.logger });
  return {
    async ingest(envelope, meta) {
      const hash = hashProviderId(envelope.providerDeliveryId, await deps.secretProvider.getDatabaseEncryptionKey());
      const delivery = await deps.repos.deliveries.findByDoordashDeliveryIdHash(hash);
      if (!delivery) {
        deps.logger.info({ eventId: envelope.eventId, outcome: 'ignored', action: 'delivery_status.webhook' }, 'Unknown delivery webhook ignored.');
        return { outcome: 'ignored' };
      }
      const event = normalizeDoorDashEvent(envelope);
      async function finish(outcome: WebhookOutcome, transitionReason: string) {
        deps.logger.info({ eventId: envelope.eventId, outcome, status: event.normalizedStatus }, 'Webhook processed.');
        await audit.record({
          tenantId: delivery!.tenantId, userId: null, deliveryId: delivery!.id,
          action: 'delivery_status.webhook', outcome: outcome === 'applied' ? 'success' : outcome,
          requestId: meta.requestId,
          metadata: { eventType: envelope.eventType, normalizedStatus: event.normalizedStatus, transitionReason },
        });
        return { outcome, deliveryId: delivery!.id, normalizedStatus: event.normalizedStatus };
      }
      const inserted = await deps.repos.deliveryEvents.insertIfAbsent({
        deliveryId: delivery.id, providerEventId: envelope.eventId, eventType: envelope.eventType,
        providerStatus: event.providerStatus, normalizedStatus: event.normalizedStatus,
        occurredAt: event.occurredAt, receivedAt: meta.receivedAt,
        sanitizedPayload: sanitizeAuditMetadata(envelope.sanitizedPayload),
      });
      if (!inserted.inserted) return finish('duplicate', 'duplicate');
      await deps.repos.deliveries.touchLastReceived(delivery.id, meta.receivedAt);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const current = await deps.repos.deliveries.findById(delivery.id);
        if (!current) return finish('stale', 'delivery_unavailable');
        const decision = decideTransition(current, event);
        if (!decision.changed) return finish('stale', decision.reason);
        const result = await deps.repos.deliveries.applyEventProjection({
          deliveryId: delivery.id, expectedLastEventAt: current.lastEventAt,
          projection: decision.projection, receivedAt: meta.receivedAt,
        });
        if (result.updated) return finish('applied', decision.reason);
      }
      return finish('stale', 'concurrent_update');
    },
  };
}
