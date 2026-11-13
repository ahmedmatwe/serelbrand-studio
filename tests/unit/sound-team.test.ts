import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { soundPlan } from '../../motion/edit.ts';
import { ROOT } from '../helpers.ts';
import { probeDuration } from '../../src/media/ffmpeg.ts';

const hl = { text: 'x' };
const scenes = [
  { type: 'hook', start: 0, end: 2, headline: hl, icon: 'star' },
  { type: 'versus', start: 2, end: 5, headline: hl, paid: { name: 'a', note: 'b' }, free: { name: 'c', note: 'd' }, freeAt: 3.5 },
  { type: 'mock', start: 5, end: 7, headline: hl, kind: 'checklist', items: [{ text: 'i', at: 5.04 }, { text: 'j', at: 6 }] },
  { type: 'mock', start: 7, end: 9, headline: hl, kind: 'chat', items: [{ text: 'k', at: 7.5 }] },
  { type: 'cta', start: 9, end: 11, headline: hl, followAt: 10 },
] as never;

test('sound team: each cut gets the fitting transition, sounds land on the cut and never pile up', () => {
  const { trans, sfx } = soundPlan(scenes);
  assert.deepEqual(trans, ['punch', 'punch', 'rise', 'whip', 'punch']);
  for (const cut of [2, 5, 7, 9]) assert.ok(sfx.some(([, at]) => Math.abs(at - (cut - 0.05)) < 1e-9), `a sound right before the cut at ${cut}`);
  for (let i = 1; i < sfx.length; i++) assert.ok(sfx[i]![1] - sfx[i - 1]![1] >= 0.1, 'no two sounds within 0.1 s');
  assert.ok(!sfx.some(([n, at]) => n === 'tick' && Math.abs(at - 5.04) < 1e-9), 'the cut sound wins over a click at the same moment');
});

test('sound team: every effect is short (≤ 0.18 s, the alert ≤ 0.35 s) so it never drags behind the picture', async () => {
  for (const f of readdirSync(`${ROOT}/motion/public/sfx`).filter((x) => x.endsWith('.wav'))) {
    const d = await probeDuration(`${ROOT}/motion/public/sfx/${f}`);
    assert.ok(d <= (f === 'alert.wav' ? 0.35 : 0.18), `${f} is ${d}s`);
  }
});
