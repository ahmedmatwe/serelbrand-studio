import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testContext } from '../helpers.ts';
import { steps } from '../../src/workflows/steps.ts';
import { MockLLM } from '../../src/providers/llm/mock.ts';
import { MOCK_FIXTURES } from '../../src/providers/llm/fixtures.ts';
import { checkCompliance } from '../../src/agents/compliance.ts';
import type { ComplianceReport } from '../../src/agents/compliance.ts';
import type { QualityReport } from '../../src/agents/quality.ts';
import type { Blueprint, FactCheckReport, Script, SeoPackage } from '../../src/agents/schemas.ts';
import type { ThumbnailOutput } from '../../src/agents/thumbnail.ts';

const CHAIN = ['scriptwriter', 'fact-checker', 'production-planner', 'thumbnail', 'seo', 'compliance', 'quality'] as const;

async function runChain() {
  const ctx = testContext();
  const v = ctx.repos.videos.create({ title: 'قصة نوكيا', format: 'long' });
  for (const s of CHAIN) {
    const id = ctx.queue.enqueue(s, { videoId: v.id });
    await ctx.queue.drain();
    assert.equal(ctx.queue.get(id)!.status, 'succeeded', `${s}: ${ctx.queue.get(id)!.last_error}`);
  }
  return { ctx, videoId: v.id };
}

test('pipeline: every step runs as a job and stores its artifact', async () => {
  const { ctx, videoId } = await runChain();
  for (const kind of ['script', 'fact_check', 'blueprint', 'thumbnails', 'seo_package', 'compliance_report', 'quality_report'])
    assert.ok(ctx.repos.artifacts.latest(videoId, kind), `missing ${kind}`);
  assert.equal(ctx.repos.videos.get(videoId)!.status, 'reviewed');
  const script = ctx.repos.artifacts.latest<Script>(videoId, 'script')!.data;
  assert.ok(script.hooks.length >= 3 && script.altTitles.length >= 5 && script.wordCount > 100);
  const bp = ctx.repos.artifacts.latest<Blueprint>(videoId, 'blueprint')!.data;
  assert.equal(bp.scenes[0]!.startSec, 0);
  assert.equal(bp.totalDurationSec, bp.scenes.reduce((a, s) => a + s.durationSec, 0));
  const seo = ctx.repos.artifacts.latest<SeoPackage>(videoId, 'seo_package')!.data;
  assert.equal(seo.chapters[0]!.startSec, 0);
  assert.ok(seo.chapters.length >= 3);
  assert.ok(ctx.cost.spentThisMonth({ includeDryRun: true }) > 0, 'dry-run costs are estimated');
  assert.equal(ctx.cost.spentThisMonth(), 0, 'no real spend in dry-run');
  assert.ok(ctx.audit.recent(100).some((e) => e.action === 'agent.completed'));
  ctx.close();
});

test('gates: mock (unverified) sources can never pass compliance', async () => {
  const { ctx, videoId } = await runChain();
  const c = ctx.repos.artifacts.latest<ComplianceReport>(videoId, 'compliance_report')!.data;
  assert.ok(c.score < 90);
  assert.ok(c.blockers.length > 0);
  assert.notEqual(c.label, 'Low risk');
  const q = ctx.repos.artifacts.latest<QualityReport>(videoId, 'quality_report')!.data;
  assert.equal(q.pendingRender, true);
  assert.equal(q.criteria.audioQuality!.score, null);
  ctx.close();
});

test('gates: a clean, verified package scores Low risk; violations are caught', async () => {
  const { ctx, videoId } = await runChain();
  const get = <T>(k: string) => ctx.repos.artifacts.latest<T>(videoId, k)!.data;
  const fc = get<FactCheckReport>('fact_check');
  const verified: FactCheckReport = { ...fc, overall: 'verified', claims: fc.claims.map((c) => ({ ...c, status: c.type === 'opinion' ? 'not_applicable' : 'verified', sourceUrl: 'https://example.org/src', humanReviewRequired: false })) };
  const base = {
    videoId, script: get<Script>('script'), factCheck: verified, blueprint: get<Blueprint>('blueprint'),
    thumbnails: get<ThumbnailOutput>('thumbnails').concepts.filter((t) => t.valid), seo: get<SeoPackage>('seo_package'),
    usesAIVoice: true, usesRealisticSyntheticMedia: true, syntheticDisclosureSet: true,
  };
  const clean = checkCompliance(base);
  assert.equal(clean.label, 'Low risk', JSON.stringify(clean.issues));
  assert.ok(clean.score >= 90);

  const noDisclosure = checkCompliance({ ...base, syntheticDisclosureSet: false });
  assert.equal(noDisclosure.label, 'Not suitable for publication');

  const badAsset = checkCompliance({ ...base, assets: [{ id: 'a', kind: 'video', path: 'x', license: 'unknown', source: 'web', aiGenerated: false }] });
  assert.equal(badAsset.copyrightStatus, 'violation');

  const misleading = checkCompliance({ ...base, seo: { ...base.seo, primaryTitle: 'لن تصدق أسرار الفضاء الخارجي المخفية' } });
  assert.ok(misleading.issues.some((i) => i.check === 'packaging.misleading_title'));
  assert.ok(misleading.issues.some((i) => i.check === 'packaging.clickbait'));
  ctx.close();
});

test('queue: transient LLM failures are retried inside the job', async () => {
  const llm = new MockLLM(MOCK_FIXTURES);
  llm.failNext = 2;
  const ctx = testContext({ llm });
  const v = ctx.repos.videos.create({ title: 't', format: 'long' });
  const id = ctx.queue.enqueue('scriptwriter', { videoId: v.id });
  await ctx.queue.drain();
  assert.equal(ctx.queue.get(id)!.status, 'succeeded');
  assert.equal(llm.calls.filter((c) => c === 'script.write').length, 3);
  ctx.close();
});

test('queue: missing inputs fail permanently and can be re-run after fixing', async () => {
  const ctx = testContext();
  const v = ctx.repos.videos.create({ title: 't', format: 'long' });
  const id = ctx.queue.enqueue('fact-checker', { videoId: v.id });
  await ctx.queue.drain();
  assert.equal(ctx.queue.get(id)!.status, 'failed');
  assert.match(ctx.queue.get(id)!.last_error!, /no "script"/);
  await steps.scriptwriter(ctx, { videoId: v.id });
  assert.ok(ctx.queue.rerun(id));
  await ctx.queue.drain();
  assert.equal(ctx.queue.get(id)!.status, 'succeeded');
  ctx.close();
});

test('pause: paused agent blocks its jobs until resumed; "*" pauses everything', async () => {
  const ctx = testContext();
  ctx.repos.agentState.setPaused('niche-selector', true, 'test');
  const id = ctx.queue.enqueue('niche-selector', {});
  await ctx.queue.drain();
  assert.equal(ctx.queue.get(id)!.status, 'blocked');
  await assert.rejects(steps['niche-selector'](ctx), /paused/);
  ctx.repos.agentState.setPaused('niche-selector', false);
  await ctx.queue.drain();
  assert.equal(ctx.queue.get(id)!.status, 'succeeded');

  ctx.repos.agentState.setPaused('*', true);
  const id2 = ctx.queue.enqueue('trend-research', { niche: 'x' });
  await ctx.queue.drain();
  assert.equal(ctx.queue.get(id2)!.status, 'blocked');
  ctx.close();
});

test('budget: real (non-dry-run) spend is blocked once the monthly budget is reached', async () => {
  const ctx = testContext({ env: { DRY_RUN: 'false', MONTHLY_BUDGET_USD: '0.0001' } });
  ctx.cost.record({ provider: 'x', operation: 'y', units: 1, unit: 'requests', usd: 0.0001 });
  const v = ctx.repos.videos.create({ title: 't', format: 'long' });
  await assert.rejects(steps.scriptwriter(ctx, { videoId: v.id }), /budget/i);
  ctx.close();
});

test('research: niche → trends → strategy produce channel-level artifacts', async () => {
  const ctx = testContext();
  const n = await steps['niche-selector'](ctx);
  assert.equal(n.ranked.length, 12);
  const t = await steps['trend-research'](ctx, { niche: n.primary });
  assert.ok(t.ideas[0]!.opportunityScore >= t.ideas.at(-1)!.opportunityScore);
  const s = await steps['content-strategy'](ctx, { niche: n.primary, startDate: '2026-11-07' });
  // 3 long videos per week (config/channel.json); the calendar never repeats a backlog item.
  assert.ok(s.summary.d90.long >= 1 && s.summary.d90.long <= 39);
  const titles = s.calendar.filter((c) => c.format === 'long').map((c) => c.title);
  assert.equal(new Set(titles).size, titles.length, 'no repeated long-video topics');
  assert.ok(s.summary.d30.short > 0);
  ctx.close();
});

test('qc: a video with too few verified facts is blocked even if nothing in it is false', async () => {
  const { qualityChecklist, qcBlockers } = await import('../../src/reports/qc.ts');
  const ctx = testContext();
  const v = ctx.repos.videos.create({ title: 't', format: 'long' });
  await steps.scriptwriter(ctx, { videoId: v.id });
  const claim = (status: string) => ({ claim: 'x', sceneN: 1, type: 'fact', sourceUrl: null, sourceTitle: null, sourceDate: null, confidence: 'high', notes: '', searchQuery: '', status, humanReviewRequired: false, reasons: [] });
  ctx.repos.artifacts.save({ videoId: v.id, kind: 'fact_check', agent: 't', data: { claims: [claim('verified'), claim('not_applicable'), claim('not_applicable')], overall: 'verified', summary: '' } });
  assert.ok(qcBlockers(qualityChecklist(ctx, v.id)).some((b) => b.includes('معلومات حقيقية مؤكدة')));
  ctx.repos.artifacts.save({ videoId: v.id, kind: 'fact_check', agent: 't', data: { claims: [1, 2, 3, 4].map(() => claim('verified')), overall: 'verified', summary: '' } });
  assert.ok(!qcBlockers(qualityChecklist(ctx, v.id)).some((b) => b.includes('معلومات حقيقية مؤكدة')));
  ctx.close();
});

test('blueprint: narration is always the verified script text, one scene per script scene', async () => {
  const ctx = testContext();
  const v = ctx.repos.videos.create({ title: 't', format: 'long' });
  await steps.scriptwriter(ctx, { videoId: v.id });
  const script = ctx.repos.artifacts.latest<Script>(v.id, 'script')!.data;
  const edited = { ...script, scenes: script.scenes.slice(0, 2).map((s) => ({ ...s, voiceover: s.voiceover + ' (نص بعد التحقق)' })) };
  ctx.repos.artifacts.save({ videoId: v.id, kind: 'script', agent: 'test', data: edited });
  await steps['production-planner'](ctx, { videoId: v.id });
  const bp = ctx.repos.artifacts.latest<Blueprint>(v.id, 'blueprint')!.data;
  assert.deepEqual(bp.scenes.map((s) => s.voiceover), edited.scenes.map((s) => s.voiceover));
  ctx.close();
});

test('publisher: never starts an upload batch that would exceed the daily YouTube quota', async () => {
  const { uploadsToday } = await import('../../src/publishing/publisher.ts');
  const ctx = testContext();
  const v = ctx.repos.videos.create({ title: 't', format: 'short' });
  const now = new Date();
  ctx.repos.artifacts.save({ videoId: v.id, kind: 'publish_log', agent: 't', data: { videoId: v.id, youtubeVideoId: 'a', visibility: 'private', provider: 'youtube', dryRun: false, uploadedAt: now.toISOString(), attempts: 1, shorts: [{ youtubeVideoId: 'b', title: 'x' }, { youtubeVideoId: 'c', title: 'y' }] } });
  const v2 = ctx.repos.videos.create({ title: 't2', format: 'long' });
  ctx.repos.artifacts.save({ videoId: v2.id, kind: 'publish_log', agent: 't', data: { videoId: v2.id, youtubeVideoId: 'old', visibility: 'private', provider: 'youtube', dryRun: false, uploadedAt: new Date(now.getTime() - 3 * 86_400_000).toISOString(), attempts: 1, shorts: [] } });
  assert.equal(uploadsToday(ctx, now), 3);
  ctx.close();
});
