import type { DoorDashWebhookEnvelope } from '../doordash/types.js';
import type { NormalizedDeliveryStatus } from '../domain/status.js';

export type WebhookOutcome = 'applied' | 'duplicate' | 'ignored' | 'stale';

export interface WebhookIngestMeta {
  requestId: string;
  receivedAt: Date;
}

export interface WebhookIngestResult {
  outcome: WebhookOutcome;
  deliveryId?: string;
  normalizedStatus?: NormalizedDeliveryStatus;
}

export interface WebhookIngestionService {
  ingest(envelope: DoorDashWebhookEnvelope, meta: WebhookIngestMeta): Promise<WebhookIngestResult>;
}
