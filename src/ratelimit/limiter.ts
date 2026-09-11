import type { RateLimiter } from './types.js';

export function createInMemoryRateLimiter(options: { limitPerMinute: number; clock?: () => Date }): RateLimiter {
  if (!Number.isFinite(options.limitPerMinute) || options.limitPerMinute <= 0) throw new RangeError('Invalid rate limit.');
  const clock = options.clock ?? (() => new Date());
  const windows = new Map<string, { used: number; resetAt: number }>();
  return {
    async consume(key, cost = 1) {
      if (!Number.isFinite(cost) || cost < 0) throw new RangeError('Invalid rate limit cost.');
      const now = clock().getTime();
      for (const [entryKey, window] of windows) {
        if (window.resetAt <= now) windows.delete(entryKey);
      }
      const window = windows.get(key) ?? { used: 0, resetAt: now + 60_000 };
      const allowed = cost <= options.limitPerMinute - window.used;
      if (allowed) window.used += cost;
      windows.set(key, window);
      return { allowed, remaining: options.limitPerMinute - window.used, resetAt: new Date(window.resetAt) };
    },
  };
}
