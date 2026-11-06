import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { GeminiLLM, extractJson } from '../../src/providers/llm/gemini.ts';
import { ProviderError, ValidationError } from '../../src/core/errors.ts';
import { testContext } from '../helpers.ts';
import { createLogger } from '../../src/core/logger.ts';

const schema = z.object({ title: z.string(), n: z.number() });
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ok = (text: string, finishReason = 'STOP') => reply({ candidates: [{ content: { parts: [{ text }] }, finishReason }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } });
const req = { task: 't', system: 's', prompt: 'p', schema, tier: 'writing' as const };

function fakeFetch(...responses: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return responses.shift()!; }) as unknown as typeof fetch;
  return { f, calls };
}

test('gemini: sends key in header (not URL), JSON mode, and validates output', async () => {
  const { f, calls } = fakeFetch(ok('{"title":"عنوان","n":3}'));
  const llm = new GeminiLLM({ apiKey: 'AIzaTESTKEY123456', models: { writing: 'gemini-x', light: 'gemini-y' }, fetchImpl: f });
  const r = await llm.generateJson(req);
  assert.deepEqual(r.data, { title: 'عنوان', n: 3 });
  assert.equal(r.usage.model, 'gemini-x');
  assert.ok(!calls[0]!.url.includes('AIza'), 'key must not be in the URL');
  assert.equal((calls[0]!.init.headers as Record<string, string>)['x-goog-api-key'], 'AIzaTESTKEY123456');
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.match(body.contents[0].parts[0].text, /JSON Schema/);
});

test('gemini: repairs schema mismatches with validation feedback', async () => {
  const { f, calls } = fakeFetch(ok('{"title":"x"}'), ok('```json\n{"title":"x","n":1}\n```'));
  const llm = new GeminiLLM({ apiKey: 'k', models: { writing: 'm', light: 'm' }, fetchImpl: f });
  const r = await llm.generateJson(req);
  assert.equal(r.data.n, 1);
  assert.equal(calls.length, 2);
  assert.match(JSON.parse(String(calls[1]!.init.body)).contents[0].parts[0].text, /failed validation/);
  assert.equal(r.usage.inputTokens, 20);
});

test('gemini: gives up with ValidationError after repair attempts', async () => {
  const { f, calls } = fakeFetch(ok('{"bad":1}'), ok('{"bad":2}'), ok('{"bad":3}'), ok('{"bad":4}'));
  const llm = new GeminiLLM({ apiKey: 'k', models: { writing: 'm', light: 'm' }, fetchImpl: f });
  await assert.rejects(llm.generateJson(req), ValidationError);
  assert.equal(calls.length, 4, '1 try + 3 repairs');
});

test('gemini: 429/5xx are retryable, 400/404/safety are not', async () => {
  const mk = (r: Response) => new GeminiLLM({ apiKey: 'k', models: { writing: 'm', light: 'm' }, fetchImpl: fakeFetch(r).f });
  const err = async (r: Response) => { try { await mk(r).generateJson(req); } catch (e) { return e as ProviderError; } throw new Error('expected failure'); };
  assert.equal((await err(reply({ error: { message: 'quota' } }, 429))).retryable, true);
  assert.equal((await err(reply({ error: { message: 'boom' } }, 503))).retryable, true);
  assert.equal((await err(reply({ error: { message: 'bad' } }, 400))).retryable, false);
  const nf = await err(reply({ error: { message: 'nf' } }, 404));
  assert.equal(nf.retryable, false);
  assert.match(nf.message, /GEMINI_MODEL/);
  assert.equal((await err(ok('', 'SAFETY'))).retryable, false);
  assert.match((await err(ok('{"title":"x"', 'MAX_TOKENS'))).message, /MAX_TOKENS/);
});

test('extractJson: tolerates fences and surrounding text', () => {
  assert.deepEqual(extractJson('Here:\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('noise {"a":[1,2]} trailing'), { a: [1, 2] });
  assert.throws(() => extractJson('no json here'), ValidationError);
});

test('context: dry-run forces mock even if LLM_PROVIDER=gemini', () => {
  const ctx = testContext({ env: { LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'AIzaFAKE000000000' } });
  assert.equal(ctx.providers.llm.name, 'mock-llm');
  ctx.close();
});

test('context: gemini is used when DRY_RUN=false, costs $0 on free tier, key never logged', async () => {
  const records: string[] = [];
  const key = 'AIzaSECRET-DO-NOT-LOG-123';
  const logger = createLogger({ console: false, level: 'debug', secrets: [key], sink: (r) => records.push(JSON.stringify(r)) });
  const ctx = testContext({ logger, env: { DRY_RUN: 'false', LLM_PROVIDER: 'gemini', GEMINI_API_KEY: key } });
  assert.equal(ctx.providers.llm.name, 'gemini');
  assert.equal(ctx.providers.llm.estimateUsd('writing', 1e6, 1e6), 0);
  logger.error('oops', { err: `401 invalid key ${key}` });
  assert.ok(records.every((r) => !r.includes(key)));
  ctx.close();
});

test('config: gemini without key is rejected with a helpful link', async () => {
  const { loadConfig } = await import('../../src/core/config.ts');
  const { ROOT } = await import('../helpers.ts');
  assert.throws(() => loadConfig({ rootDir: ROOT, envOverrides: { LLM_PROVIDER: 'gemini' } }), /aistudio\.google\.com/);
});

test('gemini: falls back to the next model on 503/404, not on 400', async () => {
  const { f, calls } = fakeFetch(reply({ error: { message: 'busy' } }, 503), reply({ error: { message: 'gone' } }, 404), ok('{"title":"x","n":2}'));
  const llm = new GeminiLLM({ apiKey: 'k', models: { writing: 'a, b ,c', light: 'c' }, fetchImpl: f });
  const r = await llm.generateJson(req);
  assert.equal(r.usage.model, 'c');
  assert.deepEqual(calls.map((c) => c.url.match(/models\/([^:]+)/)![1]), ['a', 'b', 'c']);
  const bad = new GeminiLLM({ apiKey: 'k', models: { writing: 'a,b', light: 'a' }, fetchImpl: fakeFetch(reply({ error: { message: 'bad' } }, 400)).f });
  await assert.rejects(bad.generateJson(req), /HTTP 400/);
});
