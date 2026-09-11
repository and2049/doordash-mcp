import type { DoorDashWebhookEnvelope } from '../doordash/types.js';
import { isTerminalDeliveryStatus } from './status.js';
import { mapDoorDashStatus } from './status-mapping.js';
import { summarizeStatus } from './summary.js';
import type { NormalizedDeliveryEvent } from './types.js';

export function normalizeDoorDashEvent(envelope: DoorDashWebhookEnvelope): NormalizedDeliveryEvent {
  const normalizedStatus = mapDoorDashStatus(envelope.eventType, envelope.providerStatus);
  const orderingTimestamp = envelope.occurredAt.getTime();
  const etaTimestamp = envelope.etaAt?.getTime() ?? NaN;
  const etaAt = Number.isFinite(etaTimestamp)
    && etaTimestamp >= orderingTimestamp - 60_000
    && etaTimestamp <= orderingTimestamp + 48 * 60 * 60 * 1000
    ? envelope.etaAt
    : null;

  return {
    normalizedStatus,
    providerStatus: envelope.providerStatus,
    occurredAt: envelope.occurredAt,
    etaAt,
    safeSummary: summarizeStatus(normalizedStatus),
    isTerminal: isTerminalDeliveryStatus(normalizedStatus),
    orderingTimestamp,
  };
}
