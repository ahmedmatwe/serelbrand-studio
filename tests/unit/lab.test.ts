import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge, type LabState } from '../../src/lab/lab.ts';
import { errorSignature } from '../../src/lab/errors.ts';

const arm = (id: string) => ({ id, ins: id, status: 'active' as const, born: '2026-11-12' });

test('lab: a clear winner is crowned, a clear loser retired (never below 2 live arms)', () => {
  const knobs: LabState = { cta: [arm('share'), arm('save'), arm('comment')] };
  const res = { cta: { share: { n: 5, score: 0.4 }, save: { n: 5, score: 0.1 }, comment: { n: 4, score: -0.2 } } };
  const { knobs: k, changes } = judge(knobs, res);
  assert.equal(k.cta!.find((a) => a.id === 'share')!.status, 'winner');
  assert.equal(k.cta!.find((a) => a.id === 'comment')!.status, 'retired');
  assert.equal(k.cta!.find((a) => a.id === 'save')!.status, 'active');
  assert.deepEqual(changes, ['cta: share won', 'cta: comment retired']);
});

test('lab: too few Shorts → no verdict', () => {
  const knobs: LabState = { loop: [arm('loop'), arm('direct')] };
  assert.deepEqual(judge(knobs, { loop: { loop: { n: 3, score: 1 }, direct: { n: 2, score: -1 } } }).changes, []);
});

test('errors: the same problem gets the same signature whatever the ids, numbers and titles', () => {
  const a = errorSignature('comments: youtube: HTTP 403 for vid_8db20981e2db4779 "الآيفون فيه أصوات مطر"');
  const b = errorSignature('comments: youtube: HTTP 403 for vid_fef81642664a4f66 "اقفل الأندرويد"');
  assert.equal(a, b);
  assert.notEqual(a, errorSignature('comments: youtube: HTTP 500 for vid_fef81642664a4f66 "اقفل الأندرويد"'));
});

test('motion: every Short is motion graphics, whatever an old analyst setting says', async () => {
  const { motionShare } = await import('../../src/media/motion.ts');
  assert.equal(motionShare({} as never), 1);
});
