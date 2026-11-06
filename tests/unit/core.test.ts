import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/core/config.ts';
import { createLogger, redact } from '../../src/core/logger.ts';
import { RateLimiter, withRetry } from '../../src/core/retry.ts';
import { ConfigError, ProviderError, ValidationError } from '../../src/core/errors.ts';
import { ROOT } from '../helpers.ts';

test('config: defaults are safe (dry-run on, public publishing off, all mocks)', () => {
  const c = loadConfig({ rootDir: ROOT, envOverrides: {} });
  assert.equal(c.env.DRY_RUN, true);
  assert.equal(c.env.ALLOW_PUBLIC_PUBLISHING, false);
  assert.equal(c.env.LLM_PROVIDER, 'mock');
  assert.equal(c.thresholds.compliance.minScoreToPublish, 90);
  assert.equal(c.thresholds.quality.minScoreToPublish, 85);
});

test('config: real LLM without API key is rejected', () => {
  assert.throws(() => loadConfig({ rootDir: ROOT, envOverrides: { LLM_PROVIDER: 'real' } }), ConfigError);
});

test('config: invalid values are rejected with a clear message', () => {
  assert.throws(() => loadConfig({ rootDir: ROOT, envOverrides: { LOG_LEVEL: 'loud' } }), /LOG_LEVEL/);
});

test('logger: redacts secret keys, known secret values and token patterns', () => {
  const secret = 'my-super-secret-value-123';
  const out = redact(
    { apiKey: 'abc', nested: { refresh_token: 'x' }, msg: `key=${secret}`, auth: 'Bearer abc.def', note: 'sk-ant-api03-ABCDEFGHIJKLMNOP' },
    [secret],
  ) as Record<string, any>;
  assert.equal(out.apiKey, '[REDACTED]');
  assert.equal(out.nested.refresh_token, '[REDACTED]');
  assert.equal(out.msg, 'key=[REDACTED]');
  assert.equal(out.auth, '[REDACTED]');
  assert.equal(out.note, '[REDACTED]');
});

test('logger: sink never receives raw secrets', () => {
  const records: string[] = [];
  const secret = 'sk-ant-api03-SHOULD-NOT-LEAK-0000';
  const log = createLogger({ console: false, secrets: [secret], sink: (r) => records.push(JSON.stringify(r)) });
  log.error('call failed', { error: `401 for key ${secret}`, headers: { 'x-api-key': secret } });
  assert.equal(records.length, 1);
  assert.ok(!records[0]!.includes(secret));
});

test('retry: retries transient errors then succeeds', async () => {
  let n = 0;
  const r = await withRetry(async () => { if (++n < 3) throw new ProviderError('x', 'flaky'); return 'ok'; }, { attempts: 3, baseDelayMs: 1, sleep: async () => {} });
  assert.equal(r, 'ok');
  assert.equal(n, 3);
});

test('retry: stops immediately on non-retryable errors', async () => {
  let n = 0;
  await assert.rejects(withRetry(async () => { n++; throw new ValidationError('bad'); }, { attempts: 5, baseDelayMs: 1, sleep: async () => {} }), ValidationError);
  assert.equal(n, 1);
});

test('rate limiter: enforces capacity and refills over time', () => {
  let t = 0;
  const rl = new RateLimiter(2, 1, () => t);
  assert.ok(rl.tryTake());
  assert.ok(rl.tryTake());
  assert.ok(!rl.tryTake());
  t += 1000;
  assert.ok(rl.tryTake());
});
