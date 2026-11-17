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
