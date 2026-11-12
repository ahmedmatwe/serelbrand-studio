import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverTime } from '../../src/media/cover.ts';

test('cover: the frame after the opening headline lands, never past the end', () => {
  assert.equal(coverTime({ shotLog: [{ start: 0, duration: 4 }], durationSec: 30 }), 1.6);
  assert.equal(coverTime({ shotLog: [{ start: 0, duration: 1.2 }], durationSec: 30 }), 0.9);
  assert.equal(coverTime({ durationSec: 30 }), 1.3);
  assert.equal(coverTime({ shotLog: [{ start: 0, duration: 4 }], durationSec: 1.5 }), 0.5);
});
