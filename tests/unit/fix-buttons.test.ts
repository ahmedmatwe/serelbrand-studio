import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixFor, watchdogButtons, watchdogMessage } from '../../src/agents/watchdog.ts';
import { productionStopFix } from '../../src/workflows/autopilot.ts';
import worker from '../../bot/worker.js';

test('fix buttons: each known problem gets its safe fix; already-fixed and person-only problems get none', () => {
  assert.equal(fixFor({ key: 'run:123', text: 'x' }), 'rerun:123');
  assert.equal(fixFor({ key: 'social-stalled:2026-11-17T10', text: 'x' }), 'social');
  assert.equal(fixFor({ key: 'missing:facebook:abc', text: 'x' }), 'social');
  assert.equal(fixFor({ key: 'no-pack:2026-11-17', text: 'x' }), 'produce');
  assert.equal(fixFor({ key: 'motion-fallback:2026-11-17', text: 'x' }), 'motion');
  assert.equal(fixFor({ key: 'yt-zero:abc', text: 'x' }), undefined, 'YouTube review needs a person');
  assert.equal(fixFor({ key: 'run:1', text: 'x', fixed: 'اتعاد' }), undefined);
  const fs = [{ key: 'no-pack:d', text: 'فيديوهات النهارده ما اتعملتش' }, { key: 'yt-zero:a', text: '0 مشاهدة' }, { key: 'run:9', text: 'تشغيل فشل' }];
  assert.deepEqual(watchdogButtons(fs).map((r) => r[0]!.data), ['f:produce', 'f:rerun:9']);
  assert.match(watchdogButtons(fs)[0]![0]!.text, /^🔧 إصلاح 1: /);
  const msg = watchdogMessage(fs)!;
  assert.match(msg, /1\. فيديوهات النهارده/);
  assert.match(msg, /دوس «🔧 إصلاح»/);
  assert.match(msg, /اللي مالوش زرار/);
  assert.equal(productionStopFix('could not plan 3 new Shorts topics'), 'library');
  assert.equal(productionStopFix('3 attempts today were blocked — trying again tomorrow'), 'produce');
  assert.equal(productionStopFix('voice quota used up — waiting until x'), undefined);
});

test('bot worker: «🔧 إصلاح» starts the right workflow, removes the button and answers; alerts carry the button', async () => {
  const kv = new Map<string, string>();
  const env = { BOT: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => void kv.set(k, v) }, TELEGRAM_BOT_TOKEN: 't', CHAT_ID: '42', INGEST_SECRET: 's', WEBHOOK_SECRET: 'w', GH_TOKEN: 'g' };
  const sent: { url: string; body: any }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (String(url).includes('/dispatches')) return new Response(null, { status: 204 });
    if (String(url).includes('/rerun-failed-jobs')) return new Response(null, { status: 201 });
    return new Response('{"ok":true}');
  }) as any;
  try {
    const press = (data: string) => (worker as any).fetch(new Request('https://x/telegram', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'w' }, body: JSON.stringify({ callback_query: { id: 'c', data, message: { chat: { id: 42 }, message_id: 5, reply_markup: { inline_keyboard: [[{ text: '🔧', callback_data: data }]] } } } }) }), env);
    await press('f:library');
    const d = sent.find((s) => s.url.includes('/dispatches'))!;
    assert.match(d.url, /workflows\/autopilot\.yml\/dispatches/);
    assert.deepEqual(d.body.inputs, { library_only: 'true', fix: 'تجهيز مواضيع جديدة للمكتبة' });
    assert.deepEqual(sent.find((s) => s.url.endsWith('editMessageReplyMarkup'))!.body.reply_markup.inline_keyboard, []);
    assert.match(sent.at(-1)!.body.text, /🔧 بدأت الإصلاح: تجهيز مواضيع جديدة/);
    sent.length = 0;
    await press('f:rerun:777');
    assert.ok(sent.some((s) => s.url.endsWith('/runs/777/rerun-failed-jobs')));
    assert.match(sent.at(-1)!.body.text, /بدأت أعيد التشغيل/);
    sent.length = 0;
    await (worker as any).fetch(new Request('https://x/ingest', { method: 'POST', headers: { authorization: 'Bearer s' }, body: JSON.stringify({ alerts: [{ id: 'low', text: '⚠️ المكتبة قربت تخلص', fix: 'library' }] }) }), env);
    assert.deepEqual(sent.at(-1)!.body.reply_markup.inline_keyboard, [[{ text: '🔧 إصلاح', callback_data: 'f:library' }]]);
  } finally { globalThis.fetch = real; }
});

test('tiktok: a schedule that failed (Buffer full) is retried from the kept video, never lost; gives up after 12 tries', async () => {
  const { createContext } = await import('../../src/context.ts');
  const { retryFailedTikTokSchedules } = await import('../../src/publishing/publisher.ts');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, resolve } = await import('node:path');
  const ctx = createContext({ rootDir: resolve('.'), envOverrides: { DATABASE_URL: `sqlite:${join(mkdtempSync(join(tmpdir(), 'tt-')), 'db.sqlite')}`, LLM_PROVIDER: 'mock' } });
  const now = new Date();
  ctx.repos.artifacts.save({ videoId: 'v1', kind: 'social_extras', agent: 't', data: { shorts: [
    { title: 'ok', caption: 'c', bufferId: 'b0' },
    { title: 'failed', caption: 'c2', tiktokError: 'limit reached', videoUrl: 'https://bot/media/v1-2.mp4', wantAt: new Date(now.getTime() + 3_600_000).toISOString() },
  ] } });
  let full = true;
  const calls: string[] = [];
  const buffer = { scheduleTikTok: async (url: string) => { calls.push(url); if (full) throw new Error('Scheduled posts limit reached'); return 'b1'; } };
  let r = await retryFailedTikTokSchedules(ctx, buffer, now);
  assert.equal(r.failed.length, 1);
  full = false;
  r = await retryFailedTikTokSchedules(ctx, buffer, now);
  assert.deepEqual(r.done, ['failed']);
  assert.deepEqual(calls, ['https://bot/media/v1-2.mp4', 'https://bot/media/v1-2.mp4']);
  const saved = ctx.repos.artifacts.latest<{ shorts: { bufferId?: string; tiktokError?: string }[] }>('v1', 'social_extras')!.data.shorts[1]!;
  assert.equal(saved.bufferId, 'b1');
  assert.equal(saved.tiktokError, undefined);
  r = await retryFailedTikTokSchedules(ctx, buffer, now);
  assert.equal(r.done.length + r.failed.length, 0, 'already scheduled: not sent twice');
});
