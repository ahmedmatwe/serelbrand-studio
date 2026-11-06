import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PixabayStock, pickRendition } from '../../src/providers/stock/pixabay.ts';
import { RateLimiter } from '../../src/core/retry.ts';
import { composeDescription } from '../../src/agents/seo.ts';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const fast = () => new RateLimiter(100, 100);
const VID = { id: 9, pageURL: 'https://pixabay.com/videos/x-9/', duration: 15, user: 'Omar', user_id: 5, videos: {
  large: { url: '', width: 0, height: 0, size: 0 },
  medium: { url: 'https://cdn.pixabay.com/video/m.mp4', width: 1920, height: 1080, size: 1 },
  small: { url: 'https://cdn.pixabay.com/video/s.mp4', width: 1280, height: 720, size: 1 },
} };

test('pixabay: rendition picking skips empty "large"', () => {
  assert.equal(pickRendition(VID.videos, 1920)!.width, 1920);
  assert.equal(pickRendition(VID.videos, 1000)!.width, 1280);
  assert.equal(pickRendition(VID.videos, 4000)!.width, 1920);
});

test('pixabay: video search maps credits; errors never leak the key', async () => {
  const urls: string[] = [];
  const ok = (async (u: string) => { urls.push(String(u)); return json({ hits: [VID] }); }) as unknown as typeof fetch;
  const r = await new PixabayStock('SECRETKEY123', { fetchImpl: ok, limiter: fast() }).search('old phones', 'video', { targetWidth: 1920 });
  assert.equal(r[0]!.license, 'pixabay');
  assert.equal(r[0]!.attribution, 'Omar on Pixabay');
  assert.equal(r[0]!.path, 'https://cdn.pixabay.com/video/m.mp4');
  assert.match(urls[0]!, /\/api\/videos\/\?key=SECRETKEY123&q=old\+phones/);
  const bad = new PixabayStock('SECRETKEY123', { fetchImpl: (async () => json({}, 400)) as unknown as typeof fetch, limiter: fast() });
  await assert.rejects(bad.search('x', 'image'), (e: Error) => !e.message.includes('SECRETKEY123') && /HTTP 400 for \/api\//.test(e.message));
});

test('pixabay: refuses downloads outside pixabay.com', async () => {
  const p = new PixabayStock('k', { fetchImpl: (async () => new Response('x')) as unknown as typeof fetch, limiter: fast() });
  await assert.rejects(p.download({ id: 'a', kind: 'video', path: 'https://evil.com/a.mp4', license: 'pixabay', source: 'pixabay', aiGenerated: false }, '/tmp/px-test'), /Refusing/);
});

test('description: Pixabay credits section', () => {
  const d = composeDescription({ description: 'و', hashtags: [], chapters: [] }, undefined, [{ source: 'pixabay', attribution: 'Omar on Pixabay', pageUrl: 'https://pixabay.com/videos/x-9/' }]);
  assert.match(d, /Pixabay \(https:\/\/pixabay\.com\)/);
  assert.match(d, /Omar on Pixabay/);
});

test('pixabay: search responses are cached for 24h (required by Pixabay)', async () => {
  const { mkdtempSync, rmSync, readdirSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'pxb-'));
  let calls = 0;
  const f = (async () => { calls++; return json({ hits: [VID] }); }) as unknown as typeof fetch;
  try {
    const p = new PixabayStock('SECRETKEY123', { fetchImpl: f, limiter: fast(), cacheDir: dir });
    await p.search('phones', 'video');
    const r = await p.search('phones', 'video');
    assert.equal(calls, 1);
    assert.equal(r[0]!.authorUrl, 'https://pixabay.com/users/Omar-5/');
    for (const file of readdirSync(dir)) assert.ok(!file.includes('SECRETKEY123') && !readFileSync(join(dir, file), 'utf8').includes('SECRETKEY123'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
