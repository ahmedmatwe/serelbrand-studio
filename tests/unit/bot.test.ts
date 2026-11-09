import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveReport, viralAlerts } from '../../src/publishing/bot-sync.ts';
import type { Post } from '../../src/analytics/learner.ts';
import worker from '../../bot/worker.js';

const p = (id: string, platform: Post['platform'], hoursAgo: number, now: Date, h24?: number): Post => ({ id, platform, external_id: id, title: `t-${id} #Shorts`, publish_at: new Date(now.getTime() - hoursAgo * 3_600_000).toISOString(), metrics: h24 === undefined ? {} : { h24: { views: h24 } } });

test('bot: a Short that takes off triggers one alert per milestone', () => {
  const now = new Date('2026-11-10T12:00:00Z');
  const history = [p('a', 'instagram', 100, now, 100), p('b', 'instagram', 90, now, 120), p('c', 'instagram', 80, now, 80)];
  const live = [{ post: p('x', 'instagram', 5, now), views: 1500, likes: 90 }, { post: p('y', 'instagram', 5, now), views: 200, likes: 3 }];
  const a = viralAlerts(live, history, now);
  assert.equal(a.length, 1);
  assert.equal(a[0]!.id, 'x:1000');
  assert.match(a[0]!.text, /🔥 فيديو بيضرب/);
  assert.match(a[0]!.text, /15× المعتاد/);
});

test('bot: report lists followers, each Short per platform and totals', () => {
  const now = new Date('2026-11-10T12:00:00Z');
  const r = liveReport([{ post: p('x', 'youtube', 5, now), views: 40, likes: 2 }, { post: { ...p('x2', 'instagram', 5, now), title: 't-x' }, views: 120, likes: 4 }], { youtube: 3, facebook: 1, instagram: 12 });
  assert.match(r, /👥 المتابعين:  ▶️ 3   📘 1   📸 12/);
  assert.match(r, /• t-x\n   📸 120 👁  4 👍   ▶️ 40 👁  2 👍/);
  assert.match(r, /🏆 الأقوى: t-x \(160/);
});

test('bot worker: answers only the owner; "فيديو" shows buttons; ingest needs the secret; alerts once', async () => {
  const kv = new Map<string, string>();
  const env = { BOT: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => void kv.set(k, v) }, TELEGRAM_BOT_TOKEN: 't', CHAT_ID: '42', INGEST_SECRET: 's', WEBHOOK_SECRET: 'w' };
  const sent: any[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => { sent.push({ method: String(url).split('/').pop(), body: JSON.parse(String(init.body)) }); return new Response('{"ok":true}'); }) as any;
  try {
    const post = (path: string, body: unknown, headers: Record<string, string>) => (worker as any).fetch(new Request(`https://x${path}`, { method: 'POST', headers, body: JSON.stringify(body) }), env);
    assert.equal((await post('/ingest', {}, { authorization: 'Bearer nope' })).status, 403);
    await post('/ingest', { videos: [{ title: 'كود سري', status: 'هينزل 5 م', icon: '⏰', file_id: 'F1' }], alerts: [{ id: 'a1', text: '🔥' }] }, { authorization: 'Bearer s' });
    await post('/ingest', { alerts: [{ id: 'a1', text: '🔥' }] }, { authorization: 'Bearer s' });
    assert.equal(sent.filter((x) => x.body.text === '🔥').length, 1, 'alert sent once');
    assert.equal((await post('/telegram', {}, { 'x-telegram-bot-api-secret-token': 'bad' })).status, 403);
    await post('/telegram', { message: { chat: { id: 99 }, text: 'فيديو' } }, { 'x-telegram-bot-api-secret-token': 'w' });
    assert.ok(!sent.some((x) => x.body.chat_id === '99'), 'strangers are ignored');
    await post('/telegram', { message: { chat: { id: 42 }, text: 'فيديو' } }, { 'x-telegram-bot-api-secret-token': 'w' });
    const menu = sent.at(-1)!;
    assert.deepEqual(menu.body.reply_markup.inline_keyboard.map((r: any) => r[0].callback_data), ['v:0', 'v:all']);
    await post('/telegram', { callback_query: { id: 'q', data: 'v:all', message: { chat: { id: 42 } } } }, { 'x-telegram-bot-api-secret-token': 'w' });
    assert.equal(sent.at(-1)!.method, 'sendVideo');
    assert.equal(sent.at(-1)!.body.video, 'F1');
  } finally { globalThis.fetch = real; }
});
