import type { DataFreshness, FreshnessThresholds } from './types.js';

export function computeDataFreshness(
  lastProviderUpdateAt: Date | null,
  now: Date,
  thresholds: FreshnessThresholds,
): DataFreshness {
  if (lastProviderUpdateAt === null) return 'unknown';
  const elapsedSeconds = (now.getTime() - lastProviderUpdateAt.getTime()) / 1000;
  if (!Number.isFinite(elapsedSeconds)) return 'unknown';
  if (elapsedSeconds < thresholds.delayedAfterSeconds) return 'fresh';
  if (elapsedSeconds < thresholds.staleAfterSeconds) return 'delayed';
  return 'stale';
}
