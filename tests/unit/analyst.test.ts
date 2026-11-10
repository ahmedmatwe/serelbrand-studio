import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzePerformance, buildPerformance, captionLessons, isInfraProblem, writerLessons } from '../../src/analytics/analyst.ts';
import { chooseHours } from '../../src/analytics/learner.ts';

function fakeCtx(rows: unknown[], reply: unknown) {
  const knowledge: { category: string; insight: string; confidence: number }[] = [];
  const calls: any[] = [];
  return {
    calls, knowledge,
    ctx: {
      db: { all: () => rows, run: () => {} },
      repos: {
        knowledge: { byCategory: (c: string) => knowledge.filter((k) => k.category === c).sort((a, b) => b.confidence - a.confidence), add: (k: any) => { knowledge.push({ ...k }); } },
        artifacts: { latest: (_v: string, kind: string) => kind === 'calendar_entry' ? { data: { topics: [{ title: 'كود الإشعاع', subject: 's1' }] } } : kind === 'script' ? { data: { scenes: [{ n: 1, voiceover: 'موبايلك بيطلع إشعاع قد إيه؟ اكتب الكود ده. وبعدين شوف الرقم.' }] } } : kind === 'render' ? { data: { shorts: [{ scenes: [1], durationSec: 38.4 }] } } : undefined },
      },
      providers: { llm: { generateJson: async (r: any) => { calls.push(r); return { data: reply }; } } },
    } as any,
  };
}
const row = (platform: string, views: number, at = '2026-11-09T11:00:00Z') => ({ id: `${platform}:x`, platform, external_id: 'x', video_id: 'v1', secret_id: 's1', family: 'code', title: 'كود الإشعاع #Shorts', publish_at: at, metrics: JSON.stringify({ h24: { views, likes: 1 } }) });

test('analyst: infra outages are never lessons for the writer', () => {
  assert.ok(isInfraProblem('production failed: HTTP 503: This model is currently experiencing high demand'));
  assert.ok(isInfraProblem('HTTP 429: You exceeded your current quota'));
  assert.ok(!isInfraProblem('Quality: weak clarity (0) — Avg sentence 61.3 words'));
});

test('analyst: builds per-Short facts (hook, length, numbers vs the platform usual)', () => {
  const { ctx } = fakeCtx([row('youtube', 192), row('facebook', 3), row('instagram', 152)], {});
  const [s] = buildPerformance(ctx, ctx.db.all().map((r: any) => ({ ...r, metrics: JSON.parse(r.metrics) })), new Date('2026-11-10T12:00:00Z'));
  assert.equal(s!.title, 'كود الإشعاع');
  assert.equal(s!.hook, 'موبايلك بيطلع إشعاع قد إيه؟');
  assert.equal(s!.durationSec, 38);
  assert.equal(s!.results.find((r) => r.platform === 'facebook')!.views, 3);
  assert.equal(s!.results[0]!.cairoHour, 13);
});

test('analyst: diagnosis becomes rules for the writer and captions, once a day', async () => {
  const reply = {
    diagnoses: [{ title: 'كود الإشعاع', platform: 'facebook', cause: 'Facebook page is new and the caption has no hook', evidence: '3 views vs 152 on Instagram' }],
    actions: [
      { area: 'hook', platform: 'all', rule: 'Open with the personal result in 6 words or fewer.', why: 'retention' },
      { area: 'caption', platform: 'facebook', rule: 'Start the Facebook caption with a question the viewer answers yes to.', why: 'FB 3 views' },
    ],
    summaryArabic: 'فيسبوك ضعيف عشان الصفحة جديدة والكابشن مفيهوش سؤال — هنغيّر الكابشن.',
  };
  const { ctx, calls, knowledge } = fakeCtx([row('youtube', 192), row('facebook', 3), row('instagram', 152)], reply);
  knowledge.push({ category: 'lesson', insight: 'A video was blocked before publishing because: production failed: HTTP 503 high demand — prevent this in the script.', confidence: 0.1 });
  const now = new Date('2026-11-10T12:00:00Z');
  const out = await analyzePerformance(ctx, now);
  assert.match(out[0]!, /محلل الأداء/);
  assert.equal(calls.length, 1);
  assert.deepEqual(writerLessons(ctx), ['Performance (hook): Open with the personal result in 6 words or fewer.'], 'outage lesson filtered, caption rule not for the writer');
  assert.deepEqual(captionLessons(ctx, 'facebook'), ['Performance (caption/facebook): Start the Facebook caption with a question the viewer answers yes to.']);
  assert.deepEqual(captionLessons(ctx, 'instagram'), []);
  assert.deepEqual(await analyzePerformance(ctx, now), [], 'only once a day');
  assert.equal(calls.length, 1);
});

test('learner: the trial hour is near the good hours, not 7 am, and rotates by day', () => {
  const post = { id: 'y', platform: 'youtube', external_id: 'y', publish_at: '2026-11-09T11:00:00Z', metrics: { h24: { views: 10 } } } as any;
  const a = chooseHours([{ post, score: 0 }], 3, 3, 0.6, [11, 15, 18], 1).hours;
  const b = chooseHours([{ post, score: 0 }], 3, 3, 0.6, [11, 15, 18], 2).hours;
  for (const h of [...a, ...b]) assert.ok(h >= 8, `trial hour ${h} UTC is too early`);
  assert.equal(a.length, 3);
});

test('telegram: each new learning is sent once; measuring hiccups are not', async () => {
  const { newLearnings } = await import('../../src/workflows/autopilot.ts');
  const sent: { lines: string[] }[] = [{ lines: ['⚠️ "x" على facebook: أقل من ثلث المعتاد'] }];
  const ctx = { repos: { artifacts: { listKind: () => sent.map((data) => ({ data })) } } } as any;
  assert.deepEqual(newLearnings(ctx, ['⚠️ "x" على facebook: أقل من ثلث المعتاد', '🕒 📘 فيسبوك — مواعيد', '⚠️ قياس instagram "y" فشل: 500', 'random']), ['🕒 📘 فيسبوك — مواعيد']);
});
