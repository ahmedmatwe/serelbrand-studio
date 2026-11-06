import { ProviderError, ValidationError } from '../../core/errors.ts';
import type { LLMProvider, LLMRequest, LLMResult } from './types.ts';
import { MOCK_FIXTURES } from './fixtures.ts';

export type MockFixture = (vars: Record<string, unknown>) => unknown;

/**
 * Deterministic offline LLM. Returns fixture JSON for a task and validates it with
 * the caller's schema — so agent code paths are exercised exactly like with a real model.
 */
export class MockLLM implements LLMProvider {
  readonly name = 'mock-llm';
  private readonly fixtures: Record<string, MockFixture>;
  /** Test hook: fail the next N calls with a retryable error. */
  failNext = 0;
  calls: string[] = [];

  constructor(fixtures: Record<string, MockFixture> = MOCK_FIXTURES) {
    this.fixtures = fixtures;
  }

  async generateJson<T>(req: LLMRequest<T>): Promise<LLMResult<T>> {
    this.calls.push(req.task);
    if (this.failNext > 0) {
      this.failNext--;
      throw new ProviderError('mock-llm', 'Simulated transient failure', true);
    }
    const fx = this.fixtures[req.task];
    if (!fx) throw new ProviderError('mock-llm', `No mock fixture for task "${req.task}"`, false);
    const raw = fx(req.vars ?? {});
    const parsed = req.schema.safeParse(raw);
    if (!parsed.success) {
      throw new ValidationError(`Mock fixture for "${req.task}" does not match schema: ${parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}`);
    }
    const inputTokens = Math.ceil((req.system.length + req.prompt.length) / 3);
    const outputTokens = Math.ceil(JSON.stringify(raw).length / 3);
    return { data: parsed.data, usage: { inputTokens, outputTokens, model: `mock:${req.tier}` } };
  }
}
