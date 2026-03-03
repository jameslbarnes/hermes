/**
 * Sliding window rate limiter for proactive bot messages.
 * In-memory (resets on restart, which is safe — errs on the side of posting).
 */

export interface RateLimiterConfig {
  maxPerHour: number;
  maxPerDay: number;
  cooldownMs: number;
}

const DEFAULTS: RateLimiterConfig = {
  maxPerHour: 6,
  maxPerDay: 30,
  cooldownMs: 5 * 60 * 1000, // 5 minutes
};

export class RateLimiter {
  private timestamps: number[] = [];
  private config: RateLimiterConfig;

  constructor(config?: Partial<RateLimiterConfig>) {
    this.config = { ...DEFAULTS, ...config };
  }

  /** Check whether a proactive message is allowed right now. */
  canPost(now = Date.now()): boolean {
    this.prune(now);

    // Cooldown: last post must be at least cooldownMs ago
    if (this.timestamps.length > 0) {
      const last = this.timestamps[this.timestamps.length - 1];
      if (now - last < this.config.cooldownMs) return false;
    }

    // Hourly limit
    const oneHourAgo = now - 60 * 60 * 1000;
    const inLastHour = this.timestamps.filter((t) => t > oneHourAgo).length;
    if (inLastHour >= this.config.maxPerHour) return false;

    // Daily limit
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const inLastDay = this.timestamps.filter((t) => t > oneDayAgo).length;
    if (inLastDay >= this.config.maxPerDay) return false;

    return true;
  }

  /** Record that a proactive message was sent. */
  record(now = Date.now()): void {
    this.timestamps.push(now);
  }

  /** Remove timestamps older than 24 hours. */
  private prune(now: number): void {
    const cutoff = now - 24 * 60 * 60 * 1000;
    this.timestamps = this.timestamps.filter((t) => t > cutoff);
  }

  /** How many proactive messages were sent in the last hour. */
  countLastHour(now = Date.now()): number {
    const oneHourAgo = now - 60 * 60 * 1000;
    return this.timestamps.filter((t) => t > oneHourAgo).length;
  }

  /** How many proactive messages were sent in the last 24h. */
  countLastDay(now = Date.now()): number {
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    return this.timestamps.filter((t) => t > oneDayAgo).length;
  }
}
