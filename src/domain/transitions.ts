import { DELIVERY_STATUS_RANK, isTerminalDeliveryStatus } from './status.js';
import type { DeliveryProjection, NormalizedDeliveryEvent, TransitionDecision } from './types.js';

export function decideTransition(
  current: DeliveryProjection,
  event: NormalizedDeliveryEvent,
): TransitionDecision {
  if (current.lastEventAt !== null) {
    if (isTerminalDeliveryStatus(current.status)) {
      return { changed: false, reason: 'terminal_protected', projection: current };
    }
    const currentTimestamp = current.lastEventAt.getTime();
    if (event.orderingTimestamp < currentTimestamp) {
      return { changed: false, reason: 'stale_ignored', projection: current };
    }
    if (event.orderingTimestamp === currentTimestamp
      && DELIVERY_STATUS_RANK[event.normalizedStatus] <= DELIVERY_STATUS_RANK[current.status]) {
      return { changed: false, reason: 'tie_break_rejected', projection: current };
    }
  }

  return {
    changed: true,
    reason: current.lastEventAt === null ? 'initial' : 'updated',
    projection: {
      status: event.normalizedStatus,
      providerStatus: event.providerStatus,
      etaAt: event.etaAt,
      lastEventAt: event.occurredAt,
    },
  };
}
