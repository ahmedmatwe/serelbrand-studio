import type { z } from 'zod';

export type ModelTier = 'writing' | 'light';

export interface LLMRequest<T> {
  /** Stable task id, e.g. "script.write". Mocks use it to pick a fixture. */
  task: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  tier: ModelTier;
  /** Free-form variables (also handed to mocks so fixtures can adapt). */
  vars?: Record<string, unknown>;
  maxOutputTokens?: number;
}

export interface LLMUsage { inputTokens: number; outputTokens: number; model: string }

export interface LLMResult<T> { data: T; usage: LLMUsage }

export interface LLMProvider {
  readonly name: string;
  generateJson<T>(req: LLMRequest<T>): Promise<LLMResult<T>>;
}

/** USD per 1M tokens. Keep in sync with the provider's current price list. */
export interface ModelPricing { inputPerM: number; outputPerM: number }
