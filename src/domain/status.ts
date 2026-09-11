export const NORMALIZED_DELIVERY_STATUSES = [
  'scheduled',
  'searching_for_driver',
  'driver_assigned',
  'at_restaurant',
  'preparing_or_waiting',
  'picked_up',
  'out_for_delivery',
  'arrived',
  'delivered',
  'cancelled',
  'issue',
  'unknown',
] as const;

export type NormalizedDeliveryStatus = (typeof NORMALIZED_DELIVERY_STATUSES)[number];

export const TERMINAL_DELIVERY_STATUSES = ['delivered', 'cancelled'] as const;

export type TerminalDeliveryStatus = (typeof TERMINAL_DELIVERY_STATUSES)[number];

export function isNormalizedDeliveryStatus(value: unknown): value is NormalizedDeliveryStatus {
  return typeof value === 'string' && (NORMALIZED_DELIVERY_STATUSES as readonly string[]).includes(value);
}

export function isTerminalDeliveryStatus(status: NormalizedDeliveryStatus): status is TerminalDeliveryStatus {
  return (TERMINAL_DELIVERY_STATUSES as readonly string[]).includes(status);
}

// Rank is only used as a deterministic tie-break when two events share the same
// occurred_at timestamp. Provider ordering by occurred_at always takes priority.
export const DELIVERY_STATUS_RANK: Record<NormalizedDeliveryStatus, number> = {
  unknown: 0,
  scheduled: 10,
  searching_for_driver: 20,
  driver_assigned: 30,
  at_restaurant: 40,
  preparing_or_waiting: 45,
  picked_up: 50,
  out_for_delivery: 60,
  arrived: 70,
  issue: 75,
  delivered: 80,
  cancelled: 85,
};
