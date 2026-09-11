import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../../src/crypto/field-crypto.js';
import { parseDoorDashTimestamp, parseDoorDashWebhookEnvelope } from '../../../src/doordash/webhook-schema.js';

const directory = new URL('../../../fixtures/webhooks/', import.meta.url);
const fixtures = readdirSync(directory).filter((name) => name.endsWith('.json'));
const base = { event_name: 'DASHER_CONFIRMED', external_delivery_id: 'fixture-delivery-001' };
const allowed = ['event_name', 'created_at', 'updated_at', 'pickup_time_estimated', 'pickup_time_actual', 'dropoff_time_estimated', 'dropoff_time_actual', 'cancellation_reason', 'contactless'];

function assertSafeKeys(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    expect(key).not.toMatch(/dasher|phone|address|location|instruction|image|email|tip|fee|value|tracking/i);
    assertSafeKeys(nested);
  }
}

describe('DoorDash webhook schema', () => {
  it('contains all eight fixtures', () => expect(fixtures).toHaveLength(8));

  it.each(fixtures)('parses and sanitizes %s', (file) => {
    const input: unknown = JSON.parse(readFileSync(new URL(file, directory), 'utf8'));
    const envelope = parseDoorDashWebhookEnvelope(input);
    expect(envelope.providerDeliveryId).toMatch(/^fixture-delivery-/);
    expect(envelope.eventId).toMatch(/^[a-f0-9]{64}$/);
    expect(envelope.occurredAt.toISOString()).toContain('.123Z');
    expect(Object.keys(envelope.sanitizedPayload).every((key) => allowed.includes(key))).toBe(true);
    assertSafeKeys(envelope.sanitizedPayload);
    expect(parseDoorDashWebhookEnvelope(input).eventId).toBe(envelope.eventId);
  });

  it('uses created_at for identity and updated_at for occurrence', () => {
    const payload = { ...base, created_at: '2026-09-10T12:00:00.123456Z', updated_at: '2026-09-10T12:01:00Z', dropoff_time_estimated: '2026-09-10T12:30:00.123456Z', merchant_name: 'Test Kitchen' };
    const result = parseDoorDashWebhookEnvelope(payload);
    expect(result.eventId).toBe(sha256Hex(`${base.event_name}|${base.external_delivery_id}|${payload.created_at}`));
    expect(result.occurredAt.toISOString()).toBe(payload.updated_at.replace('Z', '.000Z'));
    expect(result.etaAt?.toISOString()).toBe('2026-09-10T12:30:00.123Z');
    expect(result.merchantName).toBe('Test Kitchen');
    expect(parseDoorDashWebhookEnvelope({ ...payload, event_name: 'DASHER_PICKED_UP' }).eventId).not.toBe(result.eventId);
    expect(parseDoorDashWebhookEnvelope({ ...payload, updated_at: '2026-09-10T12:02:00Z' }).eventId).toBe(result.eventId);
  });

  it('uses fallback timestamps without making identity depend on reception time', () => {
    const now = new Date('2026-09-10T12:00:00Z');
    const result = parseDoorDashWebhookEnvelope(base, { now });
    expect(result.occurredAt).toEqual(now);
    expect(result.etaAt).toBeNull();
    expect(result.merchantName).toBeNull();
    expect(result.sanitizedPayload).toEqual({ event_name: base.event_name });
    expect(result.eventId).toBe(parseDoorDashWebhookEnvelope(base).eventId);
    const updated = parseDoorDashWebhookEnvelope({ ...base, updated_at: now.toISOString() });
    expect(updated.eventId).toBe(sha256Hex(`${base.event_name}|${base.external_delivery_id}|${now.toISOString()}`));
    expect(updated.occurredAt).toEqual(now);
    expect(parseDoorDashWebhookEnvelope({ ...base, created_at: now.toISOString() }).occurredAt).toEqual(now);
  });

  it.each([null, [], {}, { ...base, event_name: '' }, { ...base, external_delivery_id: 4 }, { ...base, updated_at: 'sensitive-invalid-date' }, { ...base, contactless: 'yes' }, { ...base, cancellation_reason: { phone: 'sensitive' } }, { ...base, pickup_time_actual: { address: 'sensitive' } }])('rejects invalid payload without echoing values: %j', (input) => {
    expect(() => parseDoorDashWebhookEnvelope(input)).toThrow('Invalid webhook payload.');
    try {
      parseDoorDashWebhookEnvelope(input);
    } catch (error) {
      expect(error).toMatchObject({ code: 'validation_error', message: 'Invalid webhook payload.' });
      expect(JSON.stringify(error)).not.toContain('sensitive');
    }
  });

  it('accepts unknown and lower-case events and strips unknown nested data', () => {
    const result = parseDoorDashWebhookEnvelope({ ...base, event_name: 'dasher_enroute_to_return', extra: { phone: 'fake' }, dasher_location: { lat: 0 } });
    expect(result.providerStatus).toBe('dasher_enroute_to_return');
    expect(result.sanitizedPayload).toEqual({ event_name: 'dasher_enroute_to_return' });
    expect(parseDoorDashTimestamp('invalid')).toBeNull();
  });
});
