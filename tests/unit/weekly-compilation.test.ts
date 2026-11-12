import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chapters } from '../../src/workflows/weekly-compilation.ts';

test('weekly compilation: chapters start at 0:00 and follow each Short', () => {
  assert.deepEqual(chapters([{ title: 'أ', durationSec: 31.4 }, { title: 'ب', durationSec: 59.9 }, { title: 'ج', durationSec: 28 }]), ['0:00 أ', '0:31 ب', '1:31 ج']);
});
