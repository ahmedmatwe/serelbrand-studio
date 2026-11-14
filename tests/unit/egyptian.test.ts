import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formalWords } from '../../src/agents/egyptian.ts';

test('egyptian editor: formal Arabic is detected, natural Egyptian passes', () => {
  assert.deepEqual(formalWords('افتحه بعد ذلك، ستظهر كل كلمة ويمكنك أيضاً'), ['ذلك', 'ستظهر', 'يمكنك', 'أيضاً']);
  assert.deepEqual(formalWords('افتحه بعد كده، هتظهر كل كلمة وتقدر كمان تدوس على الزرار'), []);
  assert.deepEqual(formalWords('بعض الأجهزة قد تتطلب إنترنت'), ['قد']);
  assert.deepEqual(formalWords('اكتب الكود *#06# دلوقتي'), []);
});
