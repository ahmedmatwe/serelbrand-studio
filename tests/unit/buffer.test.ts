import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BufferClient, hostVideo } from '../../src/publishing/buffer.ts';

test('buffer: finds the TikTok channel and schedules the video at its time', async () => {
  const calls: any[] = [];
  const f = (async (_u: string, init: RequestInit) => {
    const b = JSON.parse(String(init.body)); calls.push(b);
    assert.equal((init.headers as any).authorization, 'Bearer k');
    const json = (x: unknown) => new Response(JSON.stringify(x));
    if (b.query.includes('organizations')) return json({ data: { account: { organizations: [{ id: 'o1' }] } } });
    if (b.query.includes('channels')) return json({ data: { channels: [{ id: 'ig', service: 'instagram', name: 'x' }, { id: 'tt', service: 'tiktok', name: 'ser.mobile' }] } });
    return json({ data: { createPost: { post: { id: 'p1', dueAt: b.variables.input.dueAt } } } });
  }) as unknown as typeof fetch;
  const c = new BufferClient({ apiKey: 'k', fetchImpl: f });
  assert.equal(await c.scheduleTikTok('https://bot/media/a.mp4', 'كابشن', '2026-11-11T16:00:00.000Z'), 'p1');
  const input = calls.at(-1).variables.input;
  assert.equal(input.channelId, 'tt');
  assert.equal(input.mode, 'customScheduled');
  assert.equal(input.dueAt, '2026-11-11T16:00:00.000Z');
  assert.equal(input.assets[0].video.url, 'https://bot/media/a.mp4');
  assert.equal(input.metadata.tiktok.isAiGenerated, true, 'AI voice is disclosed');
});

test('buffer: posts only to OUR TikTok (by name) — never to كادر كورة listed first in the same account', async () => {
  const mk = (channels: { id: string; service: string; name: string }[], calls: any[] = []) => (async (_u: string, init: RequestInit) => {
    const b = JSON.parse(String(init.body)); calls.push(b);
    const json = (x: unknown) => new Response(JSON.stringify(x));
    if (b.query.includes('organizations')) return json({ data: { account: { organizations: [{ id: 'o1' }] } } });
    if (b.query.includes('channels')) return json({ data: { channels } });
    return json({ data: { createPost: { post: { id: 'p1' } } } });
  }) as unknown as typeof fetch;
  const calls: any[] = [];
  await new BufferClient({ apiKey: 'k', fetchImpl: mk([{ id: 'kk', service: 'tiktok', name: 'kader_kora' }, { id: 'sm', service: 'tiktok', name: 'ser.mobile' }], calls) }).scheduleTikTok('u', 't', '2026-11-11T16:00:00Z');
  assert.equal(calls.at(-1).variables.input.channelId, 'sm');
  await assert.rejects(new BufferClient({ apiKey: 'k', fetchImpl: mk([{ id: 'kk', service: 'tiktok', name: 'kader_kora' }]) }).scheduleTikTok('u', 't', '2026-11-11T16:00:00Z'), /no «سر الموبايل» TikTok channel \(found: kader_kora\)/);
});

test('buffer: a MutationError is an error, not a silent success', async () => {
  const f = (async (_u: string, init: RequestInit) => {
    const b = JSON.parse(String(init.body));
    const json = (x: unknown) => new Response(JSON.stringify(x));
    if (b.query.includes('organizations')) return json({ data: { account: { organizations: [{ id: 'o1' }] } } });
    if (b.query.includes('channels')) return json({ data: { channels: [{ id: 'tt', service: 'tiktok', name: 'ser.mobile' }] } });
    return json({ data: { createPost: { message: 'Video too long' } } });
  }) as unknown as typeof fetch;
  await assert.rejects(new BufferClient({ apiKey: 'k', fetchImpl: f }).scheduleTikTok('u', 't', '2026-11-11T16:00:00Z'), /Video too long/);
});

test('buffer: video is hosted on the bot with the ingest secret and a safe name', async () => {
  const d = mkdtempSync(join(tmpdir(), 'buf-')); const file = join(d, 'v.mp4'); writeFileSync(file, 'x');
  let seen = '';
  const f = (async (u: string, init: RequestInit) => { seen = u; assert.equal((init.headers as any).authorization, 'Bearer s'); return new Response(JSON.stringify({ ok: true, url: u })); }) as unknown as typeof fetch;
  const url = await hostVideo(file, 'vid_1/../x y.mp4', { BOT_URL: 'https://bot.dev/', BOT_INGEST_SECRET: 's' }, f);
  assert.equal(seen, 'https://bot.dev/media/vid_1_.._x_y.mp4');
  assert.equal(url, seen);
});
