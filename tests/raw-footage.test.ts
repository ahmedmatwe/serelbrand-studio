import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRawFootage } from '../src/media/shots.ts';
const a = (tags: string[]) => ({ tags } as never);
test('raw footage: green screen / tracking markers / mockups are rejected, normal phone clips pass', () => {
  assert.equal(isRawFootage(a(['smartphone', 'green screen', 'chroma key'])), true);
  assert.equal(isRawFootage(a(['phone', 'tracking markers'])), true);
  assert.equal(isRawFootage(a(['greenscreen'])), true);
  assert.equal(isRawFootage(a(['smartphone', 'hand', 'screen'])), false);
  assert.equal(isRawFootage(a(['green', 'forest', 'trees'])), false);
});
