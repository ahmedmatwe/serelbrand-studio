import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseTrends, scoutTrends, waitingTrends } from '../../src/agents/niche/trend-scout.ts';
import { priorityIds } from '../../src/agents/niche/topic-requests.ts';
import { loadPhoneLibrary, pickPhoneSecrets } from '../../src/agents/niche/phone-library.ts';
import type { AgentContext } from '../../src/agents/base.ts';

const TRENDS = `<rss><channel><item><title>انترنت غير محدود</title><ht:approx_traffic>20K+</ht:approx_traffic><ht:news_item_title>حملة للمطالبة بإنترنت غير محدود في مصر</ht:news_item_title></item><item><title>مباراة الأهلي</title></item></channel></rss>`;
const NEWS = `<rss><channel><item><title>رسميًا.. أسعار باقات الإنترنت بعد القرار - المصري اليوم</title></item></channel></rss>`;
const ENTRY = { kind: 'feature', platforms: 'أندرويد وآيفون', title: 'اعرف أنهي تطبيق بياكل باقة النت بتاعتك', onScreen: 'استهلاك البيانات', steps: ['الإعدادات', 'الشبكة', 'استخدام البيانات'], result: 'هتشوف كل تطبيق سحب كام ميجا.', use: 'اقفل النت عن التطبيق اللي بيسحب في الخلفية.', facts: 'Android: Settings > Network > Data usage shows per-app data. | الإعدادات ← الشبكة.', source: 'android', footage: ['phone data usage', 'wifi router'] };

function setup(replies: unknown[]) {
  const root = mkdtempSync(join(tmpdir(), 'trend-'));
  mkdirSync(join(root, 'config'), { recursive: true });
  cpSync(resolve('config/phone-secrets.json'), join(root, 'config/phone-secrets.json'));
  const arts: { kind: string; data: unknown }[] = [];
  const ctx = {
    config: { rootDir: root },
    providers: { llm: { name: 'fake', generateJson: async () => { const x = replies.shift(); if (!x) throw new Error('no reply'); return { data: x }; } } },
    repos: { artifacts: { save: (a: { kind: string; data: unknown }) => arts.push(a), listKind: (k: string) => arts.filter((a) => a.kind === k) }, knowledge: { byCategory: () => [] } },
  } as unknown as AgentContext;
  return { ctx, root, arts };
}

test('trends: both feeds are parsed (searches with traffic + news, source names stripped)', () => {
  const t = parseTrends(TRENDS, NEWS);
  assert.equal(t[0]!.title, 'انترنت غير محدود');
  assert.equal(t[0]!.traffic, '20K+');
  assert.deepEqual(t[0]!.news, ['حملة للمطالبة بإنترنت غير محدود في مصر']);
  assert.equal(t.at(-1)!.title, 'رسميًا.. أسعار باقات الإنترنت بعد القرار');
});

test('trend scout: a safe, natural bridge is researched + fact-checked and made first; at most every 3 h', async () => {
  const pick = { picks: [{ trend: 'انترنت غير محدود', link: 'الناس بتشتكي من خلصان الباقة', topic: 'إزاي تعرف أنهي تطبيق بياكل النت وتوقفه', hookAngle: 'لحد ما الإنترنت يبقى غير محدود…', heat: 9, urgency: 'now' }, { trend: 'مباراة', link: 'x', topic: 'y y y y y', hookAngle: 'z z z z', heat: 3, urgency: 'soon' }] };
  const { ctx, root } = setup([pick, { verdict: 'ok', confidence: 0.9, knownBy: 50, wow: 7, entry: ENTRY }, { verdict: 'ok', confidence: 0.9 }]);
  const fakeFetch = (async (u: string) => new Response(u.includes('trends.google') ? TRENDS : NEWS)) as typeof fetch;
  const now = new Date('2026-11-12T10:00:00Z');
  const msgs = await scoutTrends(ctx, new Set(), now, fakeFetch);
  assert.equal(msgs.length, 1, 'only the hot trend (heat ≥ 6)');
  assert.match(msgs[0]!, /انترنت غير محدود/);
  const w = waitingTrends(ctx, new Set(), now);
  assert.equal(w[0]!.entry!.trend!.urgency, 'now');
  const lib = loadPhoneLibrary(root)!;
  const id = w[0]!.entry!.id;
  assert.ok(lib.secrets.some((s) => s.id === id && s.trend));
  assert.equal(pickPhoneSecrets(lib, new Set(), 3, undefined, priorityIds(ctx, new Set(), now))[0]!.id, id);
  assert.deepEqual(await scoutTrends(ctx, new Set(), new Date('2026-11-12T11:00:00Z'), fakeFetch), [], 'not again within 3 h');
  // 3 days later the trend is stale: not waiting, not first
  const later = new Date('2026-11-15T10:00:00Z');
  assert.equal(waitingTrends(ctx, new Set(), later).length, 0);
  assert.ok(!priorityIds(ctx, new Set(), later).includes(id));
});
