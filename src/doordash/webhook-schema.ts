import { z } from 'zod';
import { sha256Hex } from '../crypto/field-crypto.js';
import { Errors } from '../errors.js';
import type { DoorDashWebhookEnvelope } from './types.js';

export function parseDoorDashTimestamp(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const timestamp = z.string().refine((value) => parseDoorDashTimestamp(value) !== null);
const safeFields = {
  event_name: z.string().min(1),
  created_at: timestamp.optional(),
  updated_at: timestamp.optional(),
  pickup_time_estimated: timestamp.optional(),
  pickup_time_actual: timestamp.optional(),
  dropoff_time_estimated: timestamp.optional(),
  dropoff_time_actual: timestamp.optional(),
  cancellation_reason: z.string().optional(),
  contactless: z.boolean().optional(),
};
const schema = z.object({
  ...safeFields,
  external_delivery_id: z.string().min(1),
  merchant_name: z.string().optional(),
}).passthrough();

export function parseDoorDashWebhookEnvelope(
  input: unknown,
  options: { now?: Date } = {},
): DoorDashWebhookEnvelope {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw Errors.validation('Invalid webhook payload.');
  const payload = parsed.data;
  const occurredAt = payload.updated_at ?? payload.created_at;
  return {
    eventId: sha256Hex(`${payload.event_name}|${payload.external_delivery_id}|${payload.created_at ?? payload.updated_at ?? ''}`),
    eventType: payload.event_name,
    providerDeliveryId: payload.external_delivery_id,
    providerStatus: payload.event_name,
    occurredAt: occurredAt ? parseDoorDashTimestamp(occurredAt)! : options.now ?? new Date(),
    etaAt: payload.dropoff_time_estimated ? parseDoorDashTimestamp(payload.dropoff_time_estimated) : null,
    merchantName: payload.merchant_name ?? null,
    sanitizedPayload: Object.fromEntries(
      Object.keys(safeFields).filter((key) => payload[key] !== undefined).map((key) => [key, payload[key]]),
    ),
  };
}
