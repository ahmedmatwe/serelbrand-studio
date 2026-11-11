import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyHook, pickHook } from '../../src/agents/hook-editor.ts';

const C = (hook: string, pattern: string, score: number) => ({ hook, pattern, score });

test('hooks: the bridge keeps what the replaced first sentence said', () => {
  const n = 'في كود سري هيكشفلك حاجة. افتح الاتصال واكتب الكود.';
  assert.equal(applyHook(n, 'مكالماتك ممكن تكون بتتحوّل!', 'وفيه كود سري هيكشفلك ده.'), 'مكالماتك ممكن تكون بتتحوّل! وفيه كود سري هيكشفلك ده. افتح الاتصال واكتب الكود.');
  assert.equal(applyHook(n, 'شوف ده!'), 'شوف ده! افتح الاتصال واكتب الكود.');
});

test('hooks: only strong candidates, weak patterns dropped, not the same style as the last Shorts', () => {
  const cands = [C('مكالماتك ممكن تكون بتتحوّل لحد تاني!', 'warning', 9.5), C('أراهنك إنك متعرفش الحركة دي خالص!', 'challenge', 9.2), C('سؤال ضعيف جدا هنا يعني', 'question', 6)];
  const none = { stats: {}, recent: [] as string[] };
  assert.equal(pickHook(cands, none)!.pattern, 'warning', 'the best when nothing is known');
  assert.equal(pickHook(cands, { stats: {}, recent: ['warning'] })!.pattern, 'challenge', 'variety: last Short used warning');
  const proven = { stats: { warning: { n: 4, score: 0.4 }, challenge: { n: 4, score: 0.7 } }, recent: [] };
  assert.equal(pickHook(cands, proven)!.pattern, 'challenge', 'warning proven weak by retention');
  assert.equal(pickHook([C('اكتب *#06# دلوقتي!', 'x', 10)], none), undefined, 'no codes in a hook');
});
