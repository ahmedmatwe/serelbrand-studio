import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createContext } from '../../src/context.ts';
import { requestedEntries } from '../../src/agents/niche/topic-requests.ts';
import type { PhoneSecret } from '../../src/agents/niche/phone-library.ts';
import { stockOf } from '../../src/agents/niche/library-agent.ts';
import { productionStopArabic } from '../../src/workflows/autopilot.ts';
import worker from '../../bot/worker.js';

const entry = (id: string, verified = false): PhoneSecret => ({
  id, kind: 'feature', platforms: 'أندرويد', title: `ميزة ${id}`, onScreen: 'x', steps: ['الإعدادات'], result: 'نتيجة واضحة للميزة', use: 'استخدام مفيد للميزة', facts: 'fact fact fact fact', source: 'android',
  ...(verified ? { verified: { at: '2026-11-17', sources: ['support.google.com'] } } : {}),
});

test('database: records not tied to a video are ALL listed (the bug that hid 73 vetted topics)', () => {
  const ctx = createContext({ rootDir: resolve('.'), envOverrides: { DATABASE_URL: `sqlite:${join(mkdtempSync(join(tmpdir(), 'lib-')), 'db.sqlite')}`, LLM_PROVIDER: 'mock' } });
  for (const i of [1, 2, 3]) ctx.repos.artifacts.save({ videoId: null, kind: 'topic_request', agent: 't', data: { request: { id: String(i), text: 't', at: '' }, status: 'approved', entry: entry(`req-auto-${i}`) } });
  // a later state of request 2 replaces the earlier one
  ctx.repos.artifacts.save({ videoId: null, kind: 'topic_request', agent: 't', data: { request: { id: '2', text: 't', at: '' }, status: 'duplicate', duplicateOf: 'req-auto-1' } });
  // per-video records still give only the latest version
  ctx.repos.artifacts.save({ videoId: 'v1', kind: 'calendar_entry', agent: 't', data: { n: 1 } });
  ctx.repos.artifacts.save({ videoId: 'v1', kind: 'calendar_entry', agent: 't', data: { n: 2 } });
  assert.equal(ctx.repos.artifacts.listKind('topic_request').length, 4);
  const states = requestedEntries(ctx);
  assert.equal(states.length, 3);
  assert.equal(states.find((r) => r.request.id === '2')!.status, 'duplicate');
  assert.deepEqual(ctx.repos.artifacts.listKind<{ n: number }>('calendar_entry').map((a) => a.data.n), [2]);
});

test('library: researched topics are produced only once proven by search; base library and owner requests always', () => {
  const lib = { secrets: [entry('ios-a'), entry('req-auto-1'), entry('req-auto-2', true), entry('req-trend-3'), entry('req-171234')] };
  assert.deepEqual(stockOf(lib, new Set()).map((s) => s.id), ['ios-a', 'req-auto-2', 'req-171234']);
  assert.deepEqual(stockOf(lib, new Set(['ios-a'])).map((s) => s.id), ['req-auto-2', 'req-171234']);
});

test('autopilot: a stop is explained to the owner in words; normal pauses are silent', () => {
  assert.match(productionStopArabic('could not plan 3 new Shorts topics')!, /مفيش مواضيع جاهزة/);
  assert.match(productionStopArabic('AI writing quota used up — waiting until 2026-11-17T08:00 UTC')!, /كوتة الذكاء الاصطناعي/);
  assert.equal(productionStopArabic("today's videos are already produced"), undefined);
  assert.equal(productionStopArabic(undefined), undefined);
});

test('bot worker: «🗑️ شيل» stores the removal, removes the button; the agent reads and clears it', async () => {
  const kv = new Map<string, string>();
  const env = { BOT: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => void kv.set(k, v) }, TELEGRAM_BOT_TOKEN: 't', CHAT_ID: '42', INGEST_SECRET: 's', WEBHOOK_SECRET: 'w' };
  const sent: { method: string; body: any }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => { sent.push({ method: String(url).split('/').pop()!, body: JSON.parse(String(init.body)) }); return new Response('{"ok":true}'); }) as any;
  try {
    const call = (path: string, method: string, body: unknown, headers: Record<string, string>) => (worker as any).fetch(new Request(`https://x${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
    await call('/ingest', 'POST', { rich: [{ text: 'مواضيع', buttons: [[{ text: '🗑️ شيل 1', data: 'x:req-auto-1' }], [{ text: '🗑️ شيل 2', data: 'x:req-auto-2' }]] }] }, { authorization: 'Bearer s' });
    assert.deepEqual(sent.at(-1)!.body.reply_markup.inline_keyboard[0][0], { text: '🗑️ شيل 1', callback_data: 'x:req-auto-1' });
    const keyboard = sent.at(-1)!.body.reply_markup.inline_keyboard;
    await call('/telegram', 'POST', { callback_query: { id: 'c', data: 'x:req-auto-1', message: { chat: { id: 42 }, message_id: 7, reply_markup: { inline_keyboard: keyboard } } } }, { 'x-telegram-bot-api-secret-token': 'w' });
    const edit = sent.find((s) => s.method === 'editMessageReplyMarkup')!;
    assert.equal(edit.body.reply_markup.inline_keyboard.length, 1, 'the pressed button is gone');
    assert.equal((await call('/vetoes', 'GET', undefined, { authorization: 'Bearer nope' })).status, 403);
    assert.deepEqual(await (await call('/vetoes', 'GET', undefined, { authorization: 'Bearer s' })).json(), { vetoes: ['req-auto-1'] });
    await call('/ingest', 'POST', { vetoesDone: ['req-auto-1'] }, { authorization: 'Bearer s' });
    assert.deepEqual(await (await call('/vetoes', 'GET', undefined, { authorization: 'Bearer s' })).json(), { vetoes: [] });
  } finally { globalThis.fetch = real; }
});
