import { z } from 'zod';
import type { Repositories } from '../db/repositories/types.js';
import { Errors } from '../errors.js';
import { computeDataFreshness } from './freshness.js';
import { isTerminalDeliveryStatus } from './status.js';
import { appendFreshnessNote, summarizeStatus } from './summary.js';
import type {
  DeliveryRecord,
  DeliveryStatusService,
  FreshnessThresholds,
  GetDeliveryStatusOutput,
} from './types.js';

const deliveryRefSchema = z.uuid();

export function createDeliveryStatusService(deps: {
  repos: Repositories;
  freshness: FreshnessThresholds;
  recentDeliveredWindowHours: number;
  clock?: () => Date;
}): DeliveryStatusService {
  const clock = deps.clock ?? (() => new Date());

  function present(record: DeliveryRecord, now: Date): GetDeliveryStatusOutput {
    const freshness = computeDataFreshness(record.lastEventAt, now, deps.freshness);
    const etaTimestamp = record.etaAt?.getTime() ?? NaN;
    const validEta = Number.isFinite(etaTimestamp);
    const minutesSinceLastUpdate = record.lastEventAt === null
      ? null
      : (now.getTime() - record.lastEventAt.getTime()) / 60_000;

    return {
      delivery_ref: record.id,
      merchant_name: record.merchantName,
      status: record.status,
      summary: appendFreshnessNote(summarizeStatus(record.status), freshness, minutesSinceLastUpdate),
      eta_at: validEta ? record.etaAt!.toISOString() : null,
      eta_minutes: validEta && etaTimestamp >= now.getTime() && freshness !== 'stale'
        ? Math.ceil((etaTimestamp - now.getTime()) / 60_000)
        : null,
      last_updated_at: (record.lastEventAt ?? record.lastReceivedAt).toISOString(),
      is_terminal: isTerminalDeliveryStatus(record.status),
      data_freshness: freshness,
    };
  }

  return {
    async getDeliveryStatus(auth, { delivery_ref }) {
      if (!deliveryRefSchema.safeParse(delivery_ref).success) throw Errors.deliveryNotFound();
      const record = await deps.repos.deliveries.findAccessibleForUser(delivery_ref, auth.userId);
      if (record === null || record.tenantId !== auth.tenantId) throw Errors.deliveryNotFound();
      return present(record, clock());
    },
    async listActiveDeliveries(auth, { include_recent_delivered }) {
      const now = clock();
      const records = await deps.repos.deliveries.listAccessibleForUser(auth.userId, {
        includeRecentDelivered: include_recent_delivered ?? false,
        recentWindowHours: deps.recentDeliveredWindowHours,
        now,
      });
      return {
        deliveries: records.filter((record) => record.tenantId === auth.tenantId).map((record) => {
          const output = present(record, now);
          return {
            delivery_ref: output.delivery_ref,
            merchant_name: output.merchant_name,
            status: output.status,
            summary: output.summary,
            eta_at: output.eta_at,
            last_updated_at: output.last_updated_at,
            is_terminal: output.is_terminal,
          };
        }),
      };
    },
  };
}
