import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vaguePenalty } from '../../src/agents/text/vague.ts';
import { pickHook } from '../../src/agents/hook-editor.ts';

test('vague: our winners are concrete, our flops are penalised', () => {
  assert.equal(vaguePenalty('الآيفون فيه أصوات مطر وبحر مخفية تساعدك تنام'), 0);
  assert.equal(vaguePenalty('كود أندرويد بيفتحلك قائمة اختبار مخفية'), 0);
  assert.ok(vaguePenalty('لو معملتش كدة واتساب بتاعك ممكن يتسرق بسهولة') >= 1.5);
  assert.ok(vaguePenalty('خلي خصوصيتك في أمان بالحركة دي') >= 2.4);
});

test('hooks: concrete beats vague at equal model score; no pattern twice in a pack; ≤ 11 words', () => {
  const st = { stats: {}, recent: [] };
  const c = [
    { hook: 'رسايلك محتاجة تأمين أكتر والحركة دي هتعملك كده', pattern: 'warning', score: 9 },
    { hook: 'واتساب فيه قفل ببصمة للمحادثات محدش يعرف عنه', pattern: 'shock-benefit', score: 8.8 },
    { hook: 'عارف إن واتساب يقدر يقفل كل محادثة لوحدها ببصمتك؟', pattern: 'question', score: 8.6 },
  ];
  assert.equal(pickHook(c, st)!.pattern, 'shock-benefit');
  assert.equal(pickHook(c, st, ['shock-benefit'])!.pattern, 'question');
  assert.equal(pickHook([{ hook: 'واحد اتنين تلاتة اربعة خمسة ستة سبعة تمانية تسعة عشرة حداشر اتناشر', pattern: 'x', score: 10 }, ...c], st)!.pattern, 'shock-benefit');
});
