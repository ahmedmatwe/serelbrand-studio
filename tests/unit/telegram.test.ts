import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Telegram, cairoTime } from '../../src/publishing/telegram.ts';

test('telegram: messages and videos go to the owner chat', async () => {
  const calls: { url: string; body: unknown }[] = [];
  const f = (async (url: string, init: RequestInit) => { calls.push({ url, body: init.body }); return new Response('{"ok":true}'); }) as unknown as typeof fetch;
  const tg = new Telegram({ token: '1:abc', chatId: '42', fetchImpl: f });
  await tg.send('مرحبا');
  const d = mkdtempSync(join(tmpdir(), 'tg-'));
  try {
    const v = join(d, 'short-1.mp4'); writeFileSync(v, Buffer.from('video'));
    await tg.video(v, '🎬 عنوان');
  } finally { rmSync(d, { recursive: true, force: true }); }
  assert.match(calls[0]!.url, /bot1:abc\/sendMessage$/);
  assert.equal(JSON.parse(String(calls[0]!.body)).chat_id, '42');
  assert.match(calls[1]!.url, /sendVideo$/);
  assert.ok(calls[1]!.body instanceof FormData);
});

test('telegram: publish times shown in Cairo time', () => {
  const now = new Date('2026-11-09T10:00:00Z');
  assert.equal(cairoTime('2026-11-09T15:00:00.000Z', now), 'النهارده 5:00 م');
  assert.equal(cairoTime('2026-11-10T09:00:00.000Z', now), 'بكرة 11:00 ص');
});
