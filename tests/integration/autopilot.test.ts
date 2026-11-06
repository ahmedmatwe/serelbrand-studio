import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { testContext, ROOT } from '../helpers.ts';
import { acquireLock, releaseLock, runCycle, todaysPlan } from '../../src/workflows/autopilot.ts';
import { startDashboard } from '../../src/dashboard/server.ts';
import { buildPlist } from '../../src/workflows/schedule-macos.ts';
import type { RenderOutput } from '../../src/media/renderer.ts';
import type { PublishLog } from '../../src/publishing/publisher.ts';
import type { MockYouTube } from '../../src/providers/media.ts';

const cleanup = (ids: string[]) => { for (const id of ids) rmSync(resolve(ROOT, 'data/renders', id), { recursive: true, force: true }); rmSync(resolve(ROOT, 'reports/daily'), { recursive: true, force: true }); };

test('lock: a second cycle cannot start while one is running', () => {
  const d = mkdtempSync(join(tmpdir(), 'lock-'));
  const p = join(d, 'a.lock');
  assert.ok(acquireLock(p));
  assert.ok(!acquireLock(p));
  assert.ok(acquireLock(p, Date.now() + 4 * 3600_000), 'stale locks are taken over');
  releaseLock(p);
  rmSync(d, { recursive: true, force: true });
});

test('plan: long video on its day, Shorts pack otherwise, missed long caught up', () => {
  const s = { calendar: [
    { day: 1, date: '2026-11-07', format: 'long', title: 'A', pillar: 'p', kind: 'evergreen' },
    { day: 2, date: '2026-11-08', format: 'short', title: 'S', pillar: 'p', kind: 'evergreen' },
    { day: 4, date: '2026-11-10', format: 'long', title: 'B', pillar: 'p', kind: 'evergreen' },
  ] } as never;
  assert.equal(todaysPlan(s, new Set(), new Date('2026-11-06'))?.title, undefined);
  assert.equal(todaysPlan(s, new Set(), new Date('2026-11-07'))?.title, 'A', 'long video day');
  assert.equal(todaysPlan(s, new Set(), new Date('2026-11-08'))?.title, 'S', 'other days: Shorts pack');
  assert.equal(todaysPlan(s, new Set(['S']), new Date('2026-11-09'))?.title, 'A', 'missed long video is caught up');
  assert.equal(todaysPlan(s, new Set(['A', 'S']), new Date('2026-11-10'))?.title, 'B');
});

test('autopilot: plans, produces with Shorts, notifies, never approves; second run same day skips; approval → upload incl. Shorts', { timeout: 600_000 }, async () => {
  const ctx = testContext();
  const notes: string[] = [];
  const ids: string[] = [];
  try {
    const r1 = await runCycle(ctx, { renderSize: 'preview', notify: (t, b) => notes.push(`${t}: ${b}`) });
    assert.deepEqual(r1.errors, []);
    assert.ok(r1.produced, 'produced a video on a calendar day');
    ids.push(r1.produced!.videoId);
    const rd = ctx.repos.artifacts.latest<RenderOutput>(r1.produced!.videoId, 'render')!.data;
    // Mock scenes are short, so the first Short already covers every curiosity-gap scene.
    assert.ok(rd.shorts.length >= 1, `expected Shorts, got ${rd.shorts.length}`);
    assert.equal(ctx.repos.approvals.pending().length, 0);
    assert.equal(r1.produced!.recommendation, 'blocked', 'mock sources keep it blocked until a human verifies');
    assert.ok(r1.needsFactReview.length === 1);
    assert.ok(notes.some((n) => n.includes('فيديو جديد')));
    assert.ok(existsSync(resolve(ROOT, 'reports/daily', `${new Date().toISOString().slice(0, 10)}.md`)));
    assert.equal(ctx.repos.videos.list().filter((v) => v.status === 'approved').length, 0, 'autopilot never approves');

    const r2 = await runCycle(ctx, { renderSize: 'preview', notify: () => {} });
    assert.equal(r2.produced, null);
    assert.match(r2.skippedProductionReason!, /already produced/);

    // Human side (dashboard): verify every claim → approval → approve → upload.
    const d = await startDashboard(ctx, 18000 + Math.floor(Math.random() * 1000));
    try {
      const home = await (await fetch(d.url)).text();
      assert.match(home, /أكّد المصادر/);
      assert.equal((await fetch(`${d.url}/claim/${ids[0]}/0`, { method: 'POST', body: new URLSearchParams({ url: '' }) })).status, 403, 'CSRF required');
      assert.equal((await fetch(`${d.url}/media/${ids[0]}/..%2F..%2F.env`)).status, 404, 'no path traversal');
      const fc = ctx.repos.artifacts.latest<{ claims: { humanReviewRequired: boolean }[] }>(ids[0]!, 'fact_check')!.data;
      for (const [i, c] of fc.claims.entries()) {
        if (!c.humanReviewRequired) continue;
        const res = await fetch(`${d.url}/claim/${ids[0]}/${i}`, { method: 'POST', redirect: 'manual', headers: { origin: d.url }, body: new URLSearchParams({ url: `https://example.org/src-${i}`, csrf: d.csrf }) });
        assert.equal(res.status, 303);
      }
      const pending = ctx.repos.approvals.pending();
      assert.equal(pending.length, 1, 'all claims verified → approval opened');
      const page2 = await (await fetch(d.url)).text();
      assert.match(page2, /مستني موافقتك/);
      assert.match(page2, /\/media\/vid_[a-f0-9]+\/video\.mp4/);
      const mediaRes = await fetch(`${d.url}/media/${ids[0]}/video.mp4`, { headers: { range: 'bytes=0-99' } });
      assert.equal(mediaRes.status, 206);
      const ap = await fetch(`${d.url}/approve/${pending[0]!.id}`, { method: 'POST', redirect: 'manual', headers: { origin: d.url }, body: new URLSearchParams({ note: 'تمام', csrf: d.csrf }) });
      assert.equal(ap.status, 303);
      for (let i = 0; i < 50 && !ctx.repos.videos.get(ids[0]!)!.youtube_video_id; i++) await new Promise((r) => setTimeout(r, 100));
    } finally { d.close(); }

    const v = ctx.repos.videos.get(ids[0]!)!;
    assert.equal(v.status, 'uploaded');
    assert.equal(v.visibility, 'private');
    const yt = ctx.providers.youtube as MockYouTube;
    const log = ctx.repos.artifacts.latest<PublishLog>(ids[0]!, 'publish_log')!.data;
    assert.equal(log.shorts.length, rd.shorts.length, 'every Short uploaded too');
    assert.ok(yt.uploads.slice(1).every((u) => u.title.endsWith('#Shorts') && u.visibility === 'private' && u.description.includes(`https://youtu.be/${v.youtube_video_id}`)));
  } finally {
    cleanup(ids);
    ctx.close();
  }
});

test('launchd plist: label, 2-hour interval, absolute node + CLI paths', () => {
  const x = buildPlist({ node: '/opt/node/bin/node', root: '/Users/a/Desktop/youtube-ai-studio', intervalSec: 7200 });
  assert.match(x, /<string>com\.serelbrand\.autopilot<\/string>/);
  assert.match(x, /<integer>7200<\/integer>/);
  assert.match(x, /<string>\/opt\/node\/bin\/node<\/string>/);
  assert.match(x, /src\/cli\/index\.ts<\/string><string>autopilot</);
  assert.ok(readFileSync !== undefined);
});

test('no repeats: near-duplicate titles are treated as already produced', async () => {
  const { isDuplicateTopic } = await import('../../src/workflows/autopilot.ts');
  assert.ok(isDuplicateTopic('قصة نوكيا: إزاي خسرت أكبر شركة موبايلات في العالم؟', ['قصة نوكيا: من القمة إلى الهاوية - لماذا سقط العملاق؟ نوكيا خسرت']));
  assert.ok(isDuplicateTopic('سقوط نوكيا وشركة الموبايلات', ['قصة نوكيا وسقوط شركة الموبايلات']));
  assert.ok(!isDuplicateTopic('كوداك اخترعت الكاميرا الرقمية', ['قصة نوكيا: إزاي خسرت السوق']));
});
