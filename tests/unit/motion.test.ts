import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captionsFromWords, codeKeyTimes, fallbackPlan, pathTimes, planMotion, stepStyle, DEFAULT_STYLE } from '../../src/media/motion.ts';
import type { AgentContext } from '../../src/agents/base.ts';
import type { PhoneSecret } from '../../src/agents/niche/phone-library.ts';

const W = (spec: string) => spec.split(' ').map((x) => { const [w, s] = x.split('@'); return { w: w!, start: Number(s), end: Number(s) + 0.3, matched: true }; });

test('motion: each key of a code is pressed when it is said (spoken or literal), spread if not heard', () => {
  const words = W('واكتب@5.9 الكود@6.5 نجمة@6.9 شباك@7.5 اتنين@7.8 واحد@8.2 شباك@8.5 ودوس@8.9');
  assert.deepEqual(codeKeyTimes(words, '*#21#', 4.6, 10.6).map((k) => `${k.k}@${k.at}`), ['*@6.9', '#@7.5', '2@7.8', '1@8.2', '#@8.5']);
  const lit = codeKeyTimes(W('اكتب@1 *#06#@2'), '*#06#', 0, 4);
  assert.equal(lit.map((k) => k.k).join(''), '*#06#');
  assert.ok(lit.every((k) => k.at >= 2 && k.at < 2.4));
  const spread = codeKeyTimes(W('كلام@1 تاني@2'), '*#06#', 0, 10);
  assert.equal(spread.length, 5);
  assert.ok(spread[0]!.at < spread[4]!.at);
});

test('motion: settings items are tapped when they are said', () => {
  const words = W('افتح@0.5 الإعدادات@1.0 وبعدين@1.6 الخصوصية@2.2 واختار@3.0 آخر@3.4 ظهور@3.7');
  assert.deepEqual(pathTimes(words, ['الإعدادات', 'الخصوصية', 'آخر ظهور'], 0, 5), [1, 2.2, 3.4]);
});

test('motion: captions are ≤ 4 words, break at sentence ends, and cover until the next chunk', () => {
  const caps = captionsFromWords(W('في@0 كود@0.3 سري@0.6 لو@0.9 كتبته@1.2 هنا.@1.5 افتح@2.0'), 3);
  assert.deepEqual(caps.map((c) => c.text), ['في كود سري لو', 'كتبته هنا', 'افتح']);
  assert.equal(caps[0]!.b, 1.2);
  assert.equal(caps.at(-1)!.b, 3);
});

test('motion: the look changes only in small steps', () => {
  const next = stepStyle(DEFAULT_STYLE, { camera: 0, captionSize: 80, transition: 'zoom' })!;
  assert.equal(next.camera, 0.45);
  assert.equal(next.captionSize, 68);
  assert.equal(next.transition, 'zoom');
  assert.equal(stepStyle(DEFAULT_STYLE, {}), undefined);
});

test('motion: without a model the fallback plan still covers the whole Short with the right phone screen', async () => {
  const entry = { id: 'x', ui: { type: 'dialer', code: '*#21#', call: true }, title: 'كود يعرفك لو حد بيحوّل مكالماتك' } as unknown as PhoneSecret;
  const ctx = { providers: { llm: { name: 'mock' } }, repos: { artifacts: { listKind: () => [] }, knowledge: { byCategory: () => [] } } } as unknown as AgentContext;
  const narration = 'في كود سري. افتح الاتصال واكتب نجمة شباك اتنين واحد شباك. هتظهرلك رسالة. جرب دلوقتي.';
  const words = W('في@0 كود@0.4 سري.@0.8 افتح@1.5 الاتصال@1.9 واكتب@2.3 نجمة@2.8 شباك@3.2 اتنين@3.5 واحد@3.8 شباك.@4.1 هتظهرلك@5 رسالة.@5.5 جرب@6.5 دلوقتي.@7');
  const plan = await planMotion(ctx, { narration, words, duration: 8, title: entry.title, entry, brand: 'سر الموبايل', endCard: 'تابع' });
  assert.equal(plan.scenes[0]!.type, 'hook');
  assert.equal(plan.scenes.at(-1)!.type, 'cta');
  assert.equal(plan.scenes[0]!.start, 0);
  assert.equal(plan.scenes.at(-1)!.end, 8);
  for (let i = 1; i < plan.scenes.length; i++) assert.equal(plan.scenes[i]!.start, plan.scenes[i - 1]!.end, 'no holes');
  const dial = plan.scenes.find((s) => s.type === 'dialer');
  assert.ok(dial && dial.type === 'dialer');
  assert.equal(dial.keys.map((k) => k.k).join(''), '*#21#');
  assert.equal(dial.keys[0]!.at, 2.8);
  assert.equal(fallbackPlan(1).length, 1);
});
