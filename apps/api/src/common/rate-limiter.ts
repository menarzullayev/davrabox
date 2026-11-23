/** Fixed-window failure limiter: after maxFailures within windowMs the key is blocked until the window ends. */
export class FailureLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly maxFailures: number, private readonly windowMs: number, private readonly now: () => number = Date.now) {}

  isBlocked(key: string): boolean {
    const e = this.hits.get(key);
    if (!e) return false;
    if (this.now() >= e.resetAt) {
      this.hits.delete(key);
      return false;
    }
    return e.count >= this.maxFailures;
  }

  recordFailure(key: string): void {
    const t = this.now();
    const e = this.hits.get(key);
    if (!e || t >= e.resetAt) this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
    else e.count += 1;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}
