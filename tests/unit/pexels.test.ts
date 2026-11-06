import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PexelsStock, pickVideoFile } from '../../src/providers/stock/pexels.ts';
import { RateLimiter } from '../../src/core/retry.ts';
import { composeDescription } from '../../src/agents/seo.ts';

const fast = () => new RateLimiter(100, 100);
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

const VIDEO = {
  id: 42, width: 3840, height: 2160, duration: 12, url: 'https://www.pexels.com/video/42/', user: { name: 'Sara', url: 'https://www.pexels.com/@sara' },
  video_files: [
    { id: 1, quality: 'sd', file_type: 'video/mp4', width: 640, height: 360, link: 'https://videos.pexels.com/1.mp4' },
    { id: 2, quality: 'hd', file_type: 'video/mp4', width: 1920, height: 1080, link: 'https://videos.pexels.com/2.mp4' },
    { id: 3, quality: 'uhd', file_type: 'video/mp4', width: 3840, height: 2160, link: 'https://videos.pexels.com/3.mp4' },
    { id: 4, quality: 'hls', file_type: 'application/x-mpegURL', width: null, height: null, link: 'https://x/hls' },
  ],
};

test('pexels: picks the smallest mp4 that is at least the target width', () => {
  assert.equal(pickVideoFile(VIDEO.video_files, 1920)!.id, 2);
  assert.equal(pickVideoFile(VIDEO.video_files, 960)!.id, 2);
  assert.equal(pickVideoFile(VIDEO.video_files, 5000)!.id, 3, 'falls back to the largest');
});

test('pexels: search sends the key as Authorization header and maps credits', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (url: string, init?: RequestInit) => { calls.push({ url: String(url), init }); return json({ videos: [VIDEO] }); }) as unknown as typeof fetch;
  const p = new PexelsStock('PEXELS-KEY-123', { fetchImpl: f, limiter: fast() });
  const r = await p.search('old mobile phones', 'video', { targetWidth: 1920 });
  assert.equal(r.length, 1);
  assert.equal(r[0]!.license, 'pexels');
  assert.equal(r[0]!.attribution, 'Sara on Pexels');
  assert.equal(r[0]!.pageUrl, 'https://www.pexels.com/video/42/');
  assert.equal(r[0]!.path, 'https://videos.pexels.com/2.mp4');
  assert.equal((calls[0]!.init!.headers as Record<string, string>).Authorization, 'PEXELS-KEY-123');
  assert.ok(!calls[0]!.url.includes('PEXELS-KEY'), 'key never in URL');
  assert.match(calls[0]!.url, /query=old\+mobile\+phones/);
});

test('pexels: falls back to /v1/videos/search on 404', async () => {
  const urls: string[] = [];
  const f = (async (url: string) => { urls.push(String(url)); return urls.length === 1 ? json({}, 404) : json({ videos: [VIDEO] }); }) as unknown as typeof fetch;
  const r = await new PexelsStock('k', { fetchImpl: f, limiter: fast() }).search('x', 'video');
  assert.equal(r.length, 1);
  assert.match(urls[1]!, /\/v1\/videos\/search/);
});

test('pexels: photo search maps photographer credit', async () => {
  const f = (async () => json({ photos: [{ id: 7, width: 4000, height: 3000, url: 'https://www.pexels.com/photo/7/', photographer: 'Ali', photographer_url: 'https://www.pexels.com/@ali', src: { original: 'https://images.pexels.com/o.jpeg', large2x: 'https://images.pexels.com/l2.jpeg', large: 'https://images.pexels.com/l.jpeg', landscape: '', portrait: '' } }] })) as unknown as typeof fetch;
  const r = await new PexelsStock('k', { fetchImpl: f, limiter: fast() }).search('x', 'image', { targetWidth: 1920 });
  assert.equal(r[0]!.kind, 'image');
  assert.equal(r[0]!.path, 'https://images.pexels.com/l2.jpeg');
  assert.equal(r[0]!.attribution, 'Ali on Pexels');
});

test('pexels: download is cached and refuses non-Pexels hosts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'px-'));
  let downloads = 0;
  const f = (async () => { downloads++; return new Response('VIDEO-BYTES', { status: 200 }); }) as unknown as typeof fetch;
  const p = new PexelsStock('k', { fetchImpl: f, limiter: fast() });
  const asset = { id: 'pexels-video-42', kind: 'video' as const, path: 'https://videos.pexels.com/2.mp4', license: 'pexels' as const, source: 'pexels', aiGenerated: false, width: 1920 };
  try {
    const a = await p.download(asset, dir);
    const b = await p.download(asset, dir);
    assert.equal(a, b);
    assert.equal(downloads, 1, 'second call served from cache');
    assert.equal(readFileSync(a, 'utf8'), 'VIDEO-BYTES');
    await assert.rejects(p.download({ ...asset, id: 'x', path: 'https://evil.example.com/x.mp4' }, dir), /Refusing/);
    await assert.rejects(p.download({ ...asset, id: 'y', path: 'http://videos.pexels.com/x.mp4' }, dir), /Refusing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pexels: 429 is retryable, 401 is not', async () => {
  const mk = (s: number) => new PexelsStock('k', { fetchImpl: (async () => json({}, s)) as unknown as typeof fetch, limiter: fast() });
  await assert.rejects(mk(429).search('x', 'image'), (e: { retryable: boolean }) => e.retryable === true);
  await assert.rejects(mk(401).search('x', 'image'), (e: { retryable: boolean }) => e.retryable === false);
});

test('description: Pexels credits are listed once per clip', () => {
  const d = composeDescription({ description: 'وصف', hashtags: ['#a'], chapters: [] }, undefined, [
    { source: 'pexels', attribution: 'Sara on Pexels', pageUrl: 'https://www.pexels.com/video/42/' },
    { source: 'pexels', attribution: 'Sara on Pexels', pageUrl: 'https://www.pexels.com/video/42/' },
    { source: 'macos-say' },
  ]);
  assert.equal((d.match(/Sara on Pexels/g) ?? []).length, 1);
  assert.match(d, /https:\/\/www\.pexels\.com\)/);
});
