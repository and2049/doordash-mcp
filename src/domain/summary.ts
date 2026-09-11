import type { NormalizedDeliveryStatus } from './status.js';
import type { DataFreshness } from './types.js';

const SUMMARIES: Record<NormalizedDeliveryStatus, string> = {
  scheduled: 'Delivery is scheduled.',
  searching_for_driver: 'Delivery is awaiting a courier assignment.',
  driver_assigned: 'A courier has been assigned to the delivery.',
  at_restaurant: 'The courier has arrived at the merchant.',
  preparing_or_waiting: 'The order is being prepared or awaiting pickup.',
  picked_up: 'The order has been picked up.',
  out_for_delivery: 'The order is out for delivery.',
  arrived: 'The courier has arrived at the delivery destination.',
  delivered: 'The order was reported as delivered.',
  cancelled: 'The delivery was cancelled.',
  issue: 'The delivery ran into an issue and may be returned.',
  unknown: 'The delivery status could not be determined.',
};

export function summarizeStatus(
  status: NormalizedDeliveryStatus,
  _options?: { merchantName?: string | null },
): string {
  return SUMMARIES[status];
}

export function appendFreshnessNote(
  summary: string,
  freshness: DataFreshness,
  minutesSinceLastUpdate: number | null,
): string {
  if (freshness !== 'stale') return summary;
  const age = minutesSinceLastUpdate !== null && Number.isFinite(minutesSinceLastUpdate)
    ? ` Last provider update was ${Math.max(0, Math.floor(minutesSinceLastUpdate))} minutes ago.`
    : '';
  return `${summary} Status data is stale.${age}`;
}
