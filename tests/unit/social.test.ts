import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MetaClient, SocialQueue, enqueue, processQueue, socialCaption } from '../../src/publishing/social.ts';

/** In-memory GitHub release + Meta Graph API. */
function fakes(failInstagramOnce = false) {
  const assets = new Map<number, { name: string; data: Buffer }>();
  let next = 1, igFails = failInstagramOnce ? 1 : 0;
  const posted: string[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status });
    if (u.hostname === 'api.github.com' && u.pathname.endsWith('/releases/tags/social-queue')) return json({ id: 7 });
    if (u.hostname === 'uploads.github.com') { assets.set(next++, { name: u.searchParams.get('name')!, data: Buffer.from(init.body as Uint8Array) }); return json({}, 201); }
    if (u.pathname.endsWith('/releases/7/assets')) return json([...assets].map(([id, a]) => ({ id, name: a.name })));
    const m = u.pathname.match(/releases\/assets\/(\d+)$/);
    if (m) { if (init.method === 'DELETE') { assets.delete(+m[1]!); return new Response(null, { status: 204 }); } return new Response(new Uint8Array(assets.get(+m[1]!)!.data)); }
    if (u.hostname === 'rupload.facebook.com') return json({ success: true });
    const body = new URLSearchParams(String(init.body ?? u.search.slice(1)));
    if (u.pathname.endsWith('/video_reels')) {
      if (body.get('upload_phase') === 'start') return json({ video_id: 'fbv1', upload_url: 'https://rupload.facebook.com/video-upload/v23.0/fbv1' });
      posted.push(`facebook:${body.get('description')?.split('\n')[0]}`); return json({ success: true });
    }
    if (u.pathname.endsWith('/media') && init.method === 'POST') { if (igFails-- > 0) return json({ error: { message: 'temporary' } }, 500); return json({ id: 'c1', uri: 'https://rupload.facebook.com/ig-api-upload/v23.0/c1' }); }
    if (u.pathname.endsWith('/c1')) return json({ status_code: 'FINISHED' });
    if (u.pathname.endsWith('/media_publish')) { posted.push('instagram'); return json({ id: 'ig1' }); }
    return json({ error: { message: `unexpected ${url}` } }, 400);
  }) as unknown as typeof fetch;
  return { f, assets, posted };
}

test('social: queued Short is posted on Facebook + Instagram at its time, then the files are deleted', async () => {
  const d = mkdtempSync(join(tmpdir(), 'soc-'));
  try {
    const file = join(d, 'short-1.mp4'); writeFileSync(file, Buffer.from('video'));
    const { f, assets, posted } = fakes();
    const q = new SocialQueue({ repo: 'o/r', token: 't', fetchImpl: f });
    const meta = new MetaClient({ pageId: 'p', token: 'pt', igUserId: 'ig', version: 'v23.0', fetchImpl: f, sleep: async () => {} });
    await enqueue(q, file, { title: 'كود سري', caption: socialCaption('كود سري #Shorts', 'اكتب الكود.', ['ايفون']), publishAt: '2026-11-09T11:00:00.000Z', platforms: ['facebook', 'instagram'] });
    assert.equal(assets.size, 2);
    assert.deepEqual(await processQueue(q, meta, new Date('2026-11-09T10:00:00Z'), d), [], 'not due yet');
    const log = await processQueue(q, meta, new Date('2026-11-09T11:05:00Z'), d);
    assert.equal(log.length, 2, log.join('\n'));
    assert.deepEqual(posted, ['facebook:كود سري', 'instagram'], 'caption has no #Shorts tag');
    assert.deepEqual([...assets.values()].map((a) => a.name), ['posted-log.json'], 'queue emptied; only the posted log stays');
    assert.equal(JSON.parse([...assets.values()][0]!.data.toString()).length, 2, 'both posts logged for the learner');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('social: a failed platform is retried next run without re-posting the other', async () => {
  const d = mkdtempSync(join(tmpdir(), 'soc-'));
  try {
    const file = join(d, 's.mp4'); writeFileSync(file, Buffer.from('v'));
    const { f, assets, posted } = fakes(true);
    const q = new SocialQueue({ repo: 'o/r', token: 't', fetchImpl: f });
    const meta = new MetaClient({ pageId: 'p', token: 'pt', igUserId: 'ig', version: 'v23.0', fetchImpl: f, sleep: async () => {} });
    await enqueue(q, file, { title: 'x', caption: 'x', publishAt: '2026-01-01T00:00:00Z', platforms: ['facebook', 'instagram'] });
    await processQueue(q, meta, new Date('2026-01-02T00:00:00Z'), d);
    assert.deepEqual(posted, ['facebook:x']);
    assert.equal([...assets.values()].filter((a) => a.name !== 'posted-log.json').length, 2, 'kept for the retry');
    await processQueue(q, meta, new Date('2026-01-02T00:15:00Z'), d);
    assert.deepEqual(posted, ['facebook:x', 'instagram'], 'facebook not posted twice');
    assert.deepEqual([...assets.values()].map((a) => a.name), ['posted-log.json']);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
