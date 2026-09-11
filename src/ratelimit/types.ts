export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
}

export interface RateLimiter {
  consume(key: string, cost?: number): Promise<RateLimitDecision>;
}
