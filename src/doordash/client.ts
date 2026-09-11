import { z } from 'zod';
import type { AppConfig } from '../config/env.js';
import { Errors } from '../errors.js';
import type { Logger } from '../logging/logger.js';
import type { DoorDashClient, DoorDashJwtProvider } from './types.js';
import { parseDoorDashTimestamp } from './webhook-schema.js';

export interface DoorDashClientDeps {
  config: Pick<AppConfig, 'DOORDASH_API_BASE_URL' | 'DOORDASH_API_TIMEOUT_MS' | 'DOORDASH_API_MAX_RETRIES'>;
  jwtProvider: DoorDashJwtProvider;
  logger: Logger;
  fetchImpl?: typeof fetch;
  clock?: () => Date;
  retryBaseDelayMs?: number;
}

const timestamp = z.string().refine((value) => parseDoorDashTimestamp(value) !== null);
const snapshotSchema = z.object({
  delivery_status: z.string().min(1),
  dropoff_time_estimated: timestamp.nullish(),
  updated_at: timestamp.optional(),
  merchant_name: z.string().nullish(),
});

export function createDoorDashClient({ config, jwtProvider, logger, fetchImpl = fetch, clock = () => new Date(), retryBaseDelayMs = 250 }: DoorDashClientDeps): DoorDashClient {
  return {
    async getDelivery(providerDeliveryId) {
      const token = await jwtProvider.getToken();
      // TODO: Confirm exact endpoint path/version and response field names against current official docs before production use.
      const url = `${(config.DOORDASH_API_BASE_URL ?? 'https://openapi.doordash.com/drive/v2').replace(/\/+$/, '')}/deliveries/${encodeURIComponent(providerDeliveryId)}`;
      for (let attempt = 0; attempt <= config.DOORDASH_API_MAX_RETRIES; attempt += 1) {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let result: { status: number; payload: unknown } | undefined;
        try {
          result = await Promise.race([
            (async () => {
              const response = await fetchImpl(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
              if (response.ok) return { status: response.status, payload: await response.json() as unknown };
              await response.body?.cancel().catch(() => undefined);
              return { status: response.status, payload: undefined };
            })(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                controller.abort();
                reject(Errors.providerUnavailable());
              }, config.DOORDASH_API_TIMEOUT_MS);
            }),
          ]);
        } catch {
          result = undefined;
        } finally {
          clearTimeout(timer);
        }
        if (result && result.status >= 200 && result.status < 300) {
          const parsed = snapshotSchema.safeParse(result.payload);
          if (!parsed.success) throw Errors.providerUnavailable();
          return {
            providerDeliveryId,
            providerStatus: parsed.data.delivery_status,
            etaAt: parsed.data.dropoff_time_estimated ? parseDoorDashTimestamp(parsed.data.dropoff_time_estimated) : null,
            occurredAt: parsed.data.updated_at ? parseDoorDashTimestamp(parsed.data.updated_at)! : clock(),
            merchantName: parsed.data.merchant_name ?? null,
          };
        }
        if (result?.status === 401 || result?.status === 403) throw Errors.integrationNotConfigured();
        const retryable = !result || result.status === 429 || result.status >= 500;
        if (!retryable || attempt === config.DOORDASH_API_MAX_RETRIES) throw Errors.providerUnavailable();
        logger.warn({ attempt: attempt + 1 }, 'Retrying DoorDash delivery request.');
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(2000, Math.max(0, retryBaseDelayMs) * 2 ** attempt * (1 + Math.random()))));
      }
      throw Errors.providerUnavailable();
    },
  };
}
