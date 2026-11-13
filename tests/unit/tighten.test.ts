import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pausesToCut, timeMap } from '../../src/media/tighten.ts';

test('tighten: pauses become a 0.1 s breath, the leading silence goes, the end stays; times move with the cut', () => {
  const cut = pausesToCut([[0, 0.28], [2.6, 3.1], [5.12, 5.25], [10, 10.9], [25.5, 26]], 0.1, 0.2, 26);
  assert.deepEqual(cut, [[0, 0.25], [2.7, 3.1], [10.1, 10.9]]); // 0.13 s pause kept, last silence kept
  const m = timeMap(cut);
  assert.equal(m(0.3), 0.05);
  assert.equal(m(3.2), 2.55);      // after: 0.25 + 0.4 removed
  assert.equal(m(2.9), 2.45);      // inside a removed gap → its start
  assert.equal(m(11), 9.55);       // 0.25 + 0.4 + 0.8 removed
});
