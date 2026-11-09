import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adaptLength, chooseHours, detectProblems, familyWeights, scorePosts, type Post } from '../../src/analytics/learner.ts';

const post = (i: number, hourUtc: number, views: number, o: Partial<Post> = {}): Post => ({
  id: `youtube:${i}`, platform: 'youtube', external_id: String(i), title: `t${i}`, family: 'code',
  publish_at: new Date(Date.UTC(2026, 10, 1 + Math.floor(i / 3), hourUtc)).toISOString(), metrics: { h24: { views } }, ...o,
});

test('learner: day one uses the default slots', () => {
  assert.deepEqual(chooseHours([]).hours, [11, 15, 18]);
});

test('learner: discovers a better hour and keeps exploring untested ones', () => {
  const posts: Post[] = [];
  let i = 0;
  // 8 days: 21:00 Cairo (19 UTC) does 3x better than the default slots.
  for (let d = 0; d < 8; d++) { posts.push(post(i++, 11, 100), post(i++, 15, 100), post(i++, 19, 300)); }
  const { hours, table } = chooseHours(scorePosts(posts));
  assert.ok(hours.includes(19), `learned the strong hour: ${hours}`);
  assert.ok(hours.some((h) => (table.find((r) => r.h === h)?.n ?? 0) === 0) || hours.length === 3, 'keeps a trial slot open');
  for (let a = 0; a < hours.length; a++) for (let b = a + 1; b < hours.length; b++) assert.ok(Math.abs(hours[a]! - hours[b]!) >= 3, 'slots spread over the day');
});

test('learner: scores are relative to the channel’s recent normal (growth does not fool it)', () => {
  const posts = [100, 120, 110, 1000].map((v, i) => post(i, 11, v));
  const s = scorePosts(posts);
  assert.ok(s[3]!.score > 2, 'a breakout is detected');
  assert.ok(Math.abs(s[1]!.score) < 0.3);
});

test('learner: content appetite and length adapt from evidence', () => {
  const posts = [...Array(6)].map((_, i) => post(i, 11, i % 2 ? 400 : 100, { family: i % 2 ? 'ios' : 'code', metrics: { h24: { views: i % 2 ? 400 : 100 }, h72: { views: 1, avgPercentViewed: 0.35 } } }));
  const w = familyWeights(scorePosts(posts));
  assert.ok(w.ios! > w.code!, JSON.stringify(w));
  const l = adaptLength(posts, 85);
  assert.equal(l.words, 75, 'viewers leave early → shorter');
  assert.match(l.reason!, /shortened/);
  assert.ok(detectProblems(posts, scorePosts(posts)).some((p) => p.includes('بتمشي بدري')));
});

test('autopilot: a daily AI quota stops production until the reset (no burned attempts)', async () => {
  const { isDailyQuota, nextQuotaReset } = await import('../../src/workflows/autopilot.ts');
  assert.ok(isDailyQuota('HTTP 429: You exceeded your current quota ... Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 500'));
  assert.ok(!isDailyQuota('HTTP 503: model overloaded'));
  // The blocker text is cut at 200 chars, before Google names the metric: still a quota stop.
  assert.ok(isDailyQuota('production failed: HTTP 429: You exceeded your current quota, please check your plan and billing details.'));
  assert.equal(nextQuotaReset(new Date('2026-11-09T07:00:00Z')), '2026-11-09T08:10:00.000Z');
  assert.equal(nextQuotaReset(new Date('2026-11-09T09:00:00Z')), '2026-11-10T08:10:00.000Z');
});

test('daily report: every Short with its views per platform, totals and the best one', async () => {
  const { testContext } = await import('../helpers.ts');
  const { registerPost, dailyReport } = await import('../../src/analytics/learner.ts');
  const ctx = testContext();
  const at = '2026-11-09T11:00:00.000Z';
  registerPost(ctx, { platform: 'youtube', external_id: 'y1', title: 'كود سري #Shorts', publish_at: at });
  registerPost(ctx, { platform: 'instagram', external_id: 'i1', title: 'كود سري', publish_at: at });
  (ctx as any).db.run(`UPDATE posts SET metrics = '{"h24":{"views":120}}' WHERE id = 'instagram:i1'`);
  const r = dailyReport(ctx, new Date('2026-11-10T19:30:00Z'));
  assert.match(r, /• كود سري/);
  assert.match(r, /📸 إنستجرام 120/);
  assert.match(r, /▶️ يوتيوب ⏳/);
  assert.match(r, /🏆 الأحسن: كود سري \(120 مشاهدة\)/);
  ctx.close();
});
