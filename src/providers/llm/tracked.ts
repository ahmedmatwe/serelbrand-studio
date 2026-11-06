import type { CostTracker } from '../../core/cost.ts';
import type { Logger } from '../../core/logger.ts';
import { RateLimiter, withRetry } from '../../core/retry.ts';
import type { LLMProvider, LLMRequest, LLMResult, ModelPricing } from './types.ts';

/** Approximate list prices (USD / 1M tokens). Verify against the provider's pricing page before going live. */
export const DEFAULT_PRICING: Record<'writing' | 'light', ModelPricing> = {
  writing: { inputPerM: 3, outputPerM: 15 },
  light: { inputPerM: 1, outputPerM: 5 },
};

export interface TrackedLLMOptions {
  cost: CostTracker;
  logger: Logger;
  attempts: number;
  baseDelayMs: number;
  pricing?: typeof DEFAULT_PRICING;
  limiter?: RateLimiter;
  sleep?: (ms: number) => Promise<void>;
}

/** Decorator adding retry, rate-limit, budget guard and cost accounting to any LLM provider. */
export class TrackedLLM implements LLMProvider {
  readonly name: string;
  private readonly inner: LLMProvider;
  private readonly o: TrackedLLMOptions;
  private readonly limiter: RateLimiter;

  constructor(inner: LLMProvider, opts: TrackedLLMOptions) {
    this.inner = inner;
    this.o = opts;
    this.name = inner.name;
    this.limiter = opts.limiter ?? new RateLimiter(10, 2);
  }

  estimateUsd(tier: 'writing' | 'light', inTok: number, outTok: number) {
    const p = (this.o.pricing ?? DEFAULT_PRICING)[tier];
    return (inTok / 1e6) * p.inputPerM + (outTok / 1e6) * p.outputPerM;
  }

  async generateJson<T>(req: LLMRequest<T> & { videoId?: string | null }): Promise<LLMResult<T>> {
    const estIn = Math.ceil((req.system.length + req.prompt.length) / 3);
    this.o.cost.assertCanSpend(this.estimateUsd(req.tier, estIn, req.maxOutputTokens ?? 4000));
    const log = this.o.logger.child('llm');
    const res = await withRetry(
      async () => {
        await this.limiter.take();
        return this.inner.generateJson(req);
      },
      {
        attempts: this.o.attempts,
        baseDelayMs: this.o.baseDelayMs,
        sleep: this.o.sleep,
        onRetry: (err, attempt, delayMs) => log.warn('llm retry', { task: req.task, attempt, delayMs, error: (err as Error).message }),
      },
    );
    const usd = this.estimateUsd(req.tier, res.usage.inputTokens, res.usage.outputTokens);
    this.o.cost.record({
      provider: this.inner.name,
      operation: req.task,
      videoId: req.videoId ?? null,
      units: res.usage.inputTokens + res.usage.outputTokens,
      unit: 'tokens',
      usd,
    });
    log.debug('llm call', { task: req.task, model: res.usage.model, usd: Number(usd.toFixed(5)) });
    return res;
  }
}
