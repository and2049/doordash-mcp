import type { NormalizedDeliveryStatus } from './status.js';

const EVENT_STATUSES = new Map<string, NormalizedDeliveryStatus>([
  ['dasher_confirmed', 'driver_assigned'],
  ['dasher_confirmed_pickup_arrival', 'at_restaurant'],
  ['dasher_picked_up', 'picked_up'],
  ['dasher_confirmed_dropoff_arrival', 'arrived'],
  ['dasher_dropped_off', 'delivered'],
  ['delivery_cancelled', 'cancelled'],
  ['delivery_return_initialized', 'issue'],
  ['dasher_confirmed_return_arrival', 'issue'],
  ['delivery_returned', 'issue'],
  ['delivery_batched', 'searching_for_driver'],
  ['dasher_enroute_to_pickup', 'driver_assigned'],
  ['dasher_enroute_to_dropoff', 'out_for_delivery'],
  ['dasher_enroute_to_return', 'issue'],
]);

const PROVIDER_STATUSES = new Map<string, NormalizedDeliveryStatus>([
  ['created', 'scheduled'],
  ['confirmed', 'driver_assigned'],
  ['enroute_to_pickup', 'driver_assigned'],
  ['arrived_at_pickup', 'at_restaurant'],
  ['picked_up', 'picked_up'],
  ['enroute_to_dropoff', 'out_for_delivery'],
  ['arrived_at_dropoff', 'arrived'],
  ['delivered', 'delivered'],
  ['cancelled', 'cancelled'],
  ['returned', 'issue'],
]);

export function mapDoorDashStatus(
  eventType: string,
  providerStatus: string | null = null,
): NormalizedDeliveryStatus {
  return EVENT_STATUSES.get(eventType.toLowerCase())
    ?? PROVIDER_STATUSES.get(providerStatus?.toLowerCase() ?? '')
    ?? 'unknown';
}
