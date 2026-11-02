/** Fixed-window-free token bucket. Refills continuously at `perMinute / 60` tokens per second. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; updated: number }>();

  constructor(private readonly perMinute: number) {}

  take(key: string, now = Date.now()): boolean {
    const b = this.buckets.get(key) ?? { tokens: this.perMinute, updated: now };
    b.tokens = Math.min(this.perMinute, b.tokens + ((now - b.updated) / 60000) * this.perMinute);
    b.updated = now;
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
    return true;
  }
}

/** Simple counting semaphore for concurrency limits. */
export class Semaphore {
  private waiters: Array<() => void> = [];
  private active = 0;

  constructor(private readonly max: number) {}

  get inUse(): number {
    return this.active;
  }

  async acquire(): Promise<() => void> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiters.shift()?.();
    };
  }
}
