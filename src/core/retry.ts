import { isRetryable } from './errors.ts';

export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Exponential backoff with jitter. Stops immediately on non-retryable StudioErrors. */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const doSleep = opts.sleep ?? sleep;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt === opts.attempts || !isRetryable(err)) throw err;
      const exp = opts.baseDelayMs * 2 ** (attempt - 1);
      const delay = Math.min(opts.maxDelayMs ?? 30_000, exp + Math.floor(Math.random() * opts.baseDelayMs));
      opts.onRetry?.(err, attempt, delay);
      await doSleep(delay);
    }
  }
  throw lastErr;
}

/** Simple token-bucket rate limiter (per provider) to respect third-party API terms. */
export class RateLimiter {
  private tokens: number;
  private last: number;
  private readonly capacity: number;
  private readonly refillPerSec: number;
  private readonly now: () => number;

  constructor(capacity: number, refillPerSec: number, now: () => number = Date.now) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.tokens = capacity;
    this.now = now;
    this.last = now();
  }

  private refill() {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.refillPerSec);
    this.last = t;
  }

  tryTake(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  async take(): Promise<void> {
    while (!this.tryTake()) await sleep(Math.ceil(1000 / this.refillPerSec));
  }
}
