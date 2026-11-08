import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measuredRender, testContext } from '../helpers.ts';
import { daily, postPublish, produceVideo, publish, review } from '../../src/workflows/orchestrator.ts';
import { approve, reject, verifyClaim } from '../../src/publishing/approval.ts';
import { proposePublishTime } from '../../src/publishing/schedule.ts';
import { renderVideoReport } from '../../src/reports/html.ts';
import { steps } from '../../src/workflows/steps.ts';
import { confidenceFor, type OptimizationReport } from '../../src/analytics/optimization.ts';
import type { MockYouTube } from '../../src/providers/media.ts';
import type { FactCheckReport } from '../../src/agents/schemas.ts';

type Ctx = ReturnType<typeof testContext>;

/** produce → (blocked) → human verifies every factual claim → review → pending approval */
async function readyForApproval(ctx: Ctx) {
  // The mock "long" script is a 2-minute stand-in, so its duration score keeps it just under the real bar.
  ctx.config.thresholds.quality.minScoreToPublish = 80;
  const first = await produceVideo(ctx, { title: 'قصة نوكيا', format: 'long' });
  const fc = ctx.repos.artifacts.latest<FactCheckReport>(first.videoId, 'fact_check')!.data;
  fc.claims.forEach((c, i) => { if (c.status !== 'not_applicable') verifyClaim(ctx, first.videoId, i, { url: `https://example.org/src-${i}`, date: '2025-06-01', by: 'tester' }); });
  measuredRender(ctx, first.videoId);
  const second = await review(ctx, first.videoId);
  return { first, second, videoId: first.videoId };
}

test('workflow: unverified facts block the video — no approval request is created', async () => {
  const ctx = testContext();
  const r = await produceVideo(ctx, { title: 'قصة نوكيا' });
  assert.equal(r.completed, true);
  assert.equal(r.report!.recommendation, 'blocked');
  assert.equal(r.approval, null);
  assert.equal(ctx.repos.approvals.pending().length, 0);
  assert.match(r.message!, /ممنوع النشر/);
  ctx.close();
});

test('workflow: human verification + review opens an approval with a full report', async () => {
  const ctx = testContext();
  const { second } = await readyForApproval(ctx);
  assert.ok(second.approval);
  const rep = second.report!;
  assert.equal(rep.hardBlockers.length, 0);
  assert.ok(rep.complianceScore >= 90);
  assert.equal(rep.factCheckStatus, 'verified');
  for (const k of ['title', 'thumbnail', 'durationSec', 'qualityScore', 'complianceScore', 'copyrightStatus', 'estimatedCostUsd', 'proposedPublishAt'] as const) assert.ok(rep[k] !== undefined, k);
  assert.equal(rep.recommendation, 'approve_with_caution', 'the 2-minute "long" mock script must raise a duration warning');
  assert.match(second.message!, /approve apr_/);
  ctx.close();
});

test('verify: only real https sources are accepted', async () => {
  const ctx = testContext();
  const r = await produceVideo(ctx, { title: 't' });
  assert.throws(() => verifyClaim(ctx, r.videoId, 0, { url: 'mock://x', by: 't' }), /https/);
  assert.throws(() => verifyClaim(ctx, r.videoId, 99, { url: 'https://example.org/a', by: 't' }), /No claim/);
  ctx.close();
});

test('approval: public and scheduled publishing are refused while ALLOW_PUBLIC_PUBLISHING=false', async () => {
  const ctx = testContext();
  const { second } = await readyForApproval(ctx);
  const id = second.approval!.id;
  assert.throws(() => approve(ctx, id, { by: 't', visibility: 'public', acceptRisks: true, note: 'x' }), /ALLOW_PUBLIC_PUBLISHING/);
  assert.throws(() => approve(ctx, id, { by: 't', publishAt: '2026-12-01T17:00:00Z', acceptRisks: true, note: 'x' }), /ALLOW_PUBLIC_PUBLISHING/);
  assert.throws(() => approve(ctx, id, { by: 't' }), /accept-risks/);
  const a = approve(ctx, id, { by: 't', acceptRisks: true, note: 'known short mock' });
  assert.equal(a.status, 'approved');
  assert.equal(a.requested_visibility, 'private');
  assert.throws(() => approve(ctx, id, { by: 't', acceptRisks: true, note: 'again' }), /already approved/);
  ctx.close();
});

test('approval: becomes stale if content changes after the report', async () => {
  const ctx = testContext();
  const { second, videoId } = await readyForApproval(ctx);
  await new Promise((r) => setTimeout(r, 5));
  await steps.thumbnail(ctx, { videoId });
  assert.throws(() => approve(ctx, second.approval!.id, { by: 't', acceptRisks: true, note: 'x' }), /changed after the report/);
  ctx.close();
});

test('reject: marks the video rejected and closes the approval', async () => {
  const ctx = testContext();
  const { second, videoId } = await readyForApproval(ctx);
  reject(ctx, second.approval!.id, 't', 'not good enough');
  assert.equal(ctx.repos.videos.get(videoId)!.status, 'rejected');
  assert.throws(() => approve(ctx, second.approval!.id, { by: 't', acceptRisks: true, note: 'x' }), /already rejected/);
  ctx.close();
});

test('publisher: refuses without approval; uploads private with synthetic disclosure after approval; never twice', async () => {
  const ctx = testContext();
  const { second, videoId } = await readyForApproval(ctx);
  const before = await publish(ctx, videoId);
  assert.equal(before.status, 'failed');
  assert.match(before.error!, /No human approval/);

  approve(ctx, second.approval!.id, { by: 't', acceptRisks: true, note: 'ok' });
  const ok = await publish(ctx, videoId);
  assert.equal(ok.status, 'succeeded', ok.error ?? '');
  const v = ctx.repos.videos.get(videoId)!;
  assert.equal(v.status, 'uploaded');
  assert.equal(v.visibility, 'private');
  const yt = ctx.providers.youtube as MockYouTube;
  assert.equal(yt.uploads.length, 1);
  assert.equal(yt.uploads[0]!.visibility, 'private');
  assert.equal(yt.uploads[0]!.containsSyntheticMedia, true);
  assert.ok(yt.uploads[0]!.description.includes('https://example.org/src-0'), 'verified sources are listed in the description');

  const again = await publish(ctx, videoId);
  assert.equal(again.status, 'failed');
  assert.equal(yt.uploads.length, 1);
  ctx.close();
});

test('publisher: public is possible only when explicitly enabled AND approved as public', async () => {
  const ctx = testContext({ env: { ALLOW_PUBLIC_PUBLISHING: 'true' } });
  const { second, videoId } = await readyForApproval(ctx);
  approve(ctx, second.approval!.id, { by: 't', visibility: 'public', acceptRisks: true, note: 'go' });
  assert.equal((await publish(ctx, videoId)).status, 'succeeded');
  assert.equal(ctx.repos.videos.get(videoId)!.status, 'published');
  ctx.close();
});

test('analytics: checkpoints are captured once each; optimization reports capped confidence and caveats', async () => {
  const ctx = testContext();
  const { second, videoId } = await readyForApproval(ctx);
  approve(ctx, second.approval!.id, { by: 't', acceptRisks: true, note: 'ok' });
  await publish(ctx, videoId);

  const r1 = await postPublish(ctx, videoId, 24);
  assert.deepEqual(ctx.repos.analytics.forVideo(videoId).map((s) => s.checkpointHours), [1, 6, 24]);
  await postPublish(ctx, videoId, 24);
  assert.equal(ctx.repos.analytics.forVideo(videoId).length, 3, 'idempotent');
  const r2 = await postPublish(ctx, videoId, 168);
  assert.deepEqual(ctx.repos.analytics.forVideo(videoId).map((s) => s.checkpointHours), [1, 6, 24, 72, 168]);

  assert.ok(r1.report!.confidence <= 0.4);
  assert.ok(r2.report!.confidence <= 0.4, 'one video can never be a confident conclusion');
  assert.equal(r2.report!.strategicConclusionsAllowed, false);
  assert.ok(r2.report!.caveats.some((c) => c.includes('Mock')));
  ctx.close();
});

test('optimization: detects low CTR against the channel median', async () => {
  const ctx = testContext();
  const mk = (title: string, ctr: number) => {
    const v = ctx.repos.videos.create({ title, format: 'long' });
    ctx.repos.videos.update(v.id, { youtube_video_id: `yt_${title}`, status: 'uploaded' });
    ctx.repos.analytics.save(v.id, 168, { impressions: 10000, ctr, views: 10000 * ctr, avgPercentViewed: 0.45, subscribersGained: 10000 * ctr * 0.01 }, 'mock');
    return v.id;
  };
  ['a', 'b', 'c', 'd'].forEach((t) => mk(t, 0.06));
  const weak = mk('weak', 0.02);
  const r = (await steps.optimization(ctx, { videoId: weak })) as OptimizationReport;
  assert.equal(r.diagnoses[0]!.metric, 'ctr');
  assert.equal(r.diagnoses[0]!.benchmarkSource, 'channel-median');
  assert.equal(r.experiment!.variable, 'thumbnail');
  assert.match(r.experiment!.rule, /متغيراً واحداً/);
  assert.ok(r.knowledgeWritten > 0);
  assert.ok(confidenceFor(168, 8, 8) > confidenceFor(168, 2, 8));
  ctx.close();
});

test('schedule: next slot ≥ 1h ahead; uses learned hour only with enough samples', () => {
  const ctx = testContext();
  const now = new Date('2026-11-06T10:00:00Z');
  const p = proposePublishTime(ctx.repos.knowledge, { now, minSamples: 8 });
  assert.equal(p.at, '2026-11-06T17:00:00.000Z', 'same day 19:00 Cairo');
  assert.equal(proposePublishTime(ctx.repos.knowledge, { now, minSamples: 8, format: 'short' }).at, '2026-11-06T11:00:00.000Z');
  assert.equal(proposePublishTime(ctx.repos.knowledge, { now: new Date('2026-11-06T16:30:00Z'), minSamples: 8 }).at, '2026-11-07T17:00:00.000Z', 'less than 1h lead → next day');
  assert.match(p.rationale, /افتراض/);
  ctx.repos.knowledge.add({ category: 'publish_time', insight: 'utc_hour=19', confidence: 0.5, sampleSize: 3 });
  assert.equal(new Date(proposePublishTime(ctx.repos.knowledge, { now, minSamples: 8 }).at).getUTCHours(), 17);
  ctx.repos.knowledge.add({ category: 'publish_time', insight: 'utc_hour=19', confidence: 0.7, sampleSize: 12 });
  assert.equal(new Date(proposePublishTime(ctx.repos.knowledge, { now, minSamples: 8 }).at).getUTCHours(), 19);
  ctx.close();
});

test('daily: picks the best idea that was not produced yet', async () => {
  const ctx = testContext();
  const d1 = await daily(ctx, 'business-stories');
  assert.ok(d1.picked && d1.result);
  ctx.repos.videos.update(d1.result!.videoId, { title: d1.picked!.title });
  const d2 = await daily(ctx, 'business-stories');
  assert.notEqual(d2.picked!.title, d1.picked!.title);
  ctx.close();
});

test('html report: RTL, all sections present, content escaped', async () => {
  const ctx = testContext();
  const { videoId } = await readyForApproval(ctx);
  ctx.repos.videos.update(videoId, { title: '<script>alert(1)</script>' });
  const html = renderVideoReport(ctx, videoId);
  assert.match(html, /dir="rtl"/);
  for (const h of ['تقرير ما قبل النشر', 'السكريبت', 'تدقيق الحقائق', 'فحص الامتثال', 'فحص الجودة', 'خطة الإنتاج', 'مفاهيم الصورة المصغّرة']) assert.ok(html.includes(h), h);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  ctx.close();
});

test('publisher: scheduled long video → its Shorts go out at the next Shorts slots', async () => {
  const ctx = testContext({ env: { ALLOW_PUBLIC_PUBLISHING: 'true' } });
  const { second, videoId } = await readyForApproval(ctx);
  measuredRender(ctx, videoId, { shorts: [{ path: '/tmp/s1.mp4', title: 'a' }, { path: '/tmp/s2.mp4', title: 'b' }] });
  const at = '2026-11-08T17:00:00.000Z';
  approve(ctx, second.approval!.id, { by: 't', publishAt: at, acceptRisks: true, note: 'ok' });
  assert.equal((await publish(ctx, videoId)).status, 'succeeded');
  const ups = (ctx.providers.youtube as MockYouTube).uploads;
  assert.equal(ups[0]!.publishAt, at);
  assert.equal(ups[1]!.publishAt, '2026-11-08T18:00:00.000Z');
  assert.equal(ups[2]!.publishAt, '2026-11-09T11:00:00.000Z');
  ctx.close();
});
