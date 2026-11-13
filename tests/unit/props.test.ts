import { test } from 'node:test';
import assert from 'node:assert/strict';
import { propNames, resolveProp, propUrl } from '../../src/media/motion.ts';

test('props: the director\'s words map to real 3D objects; unsuitable ones are not in the catalog', () => {
  assert.ok(propNames().length > 1000);
  assert.equal(resolveProp('running shoe'), 'running shoe');
  assert.equal(resolveProp('flying money with wings'), 'money with wings');
  assert.equal(resolveProp('quantum spaceship engine'), undefined);
  for (const bad of ['wine glass', 'bikini', 'beer mug', 'cigarette']) assert.equal(propNames().includes(bad), false, bad);
  assert.match(propUrl('robot'), /^https:\/\/cdn\.jsdelivr\.net\/gh\/microsoft\/fluentui-emoji@main\/assets\/Robot\/3D\/robot_3d\.png$/);
});

test('motion plan: plain statements and empty screens become stories or acted-out checklists; screens are never merged', async () => {
  const { normalizePlan } = await import('../../src/media/motion.ts');
  const h = (text: string) => ({ text });
  const out = normalizePlan([
    { type: 'hook', from: 0, to: 0, headline: h('a') },
    { type: 'statement', from: 1, to: 1, headline: h('b'), props: [{ thing: 'headphone', sentence: 1, action: 'pop' }] },
    { type: 'mock', from: 2, to: 2, headline: h('c'), props: [{ thing: 'robot', sentence: 2, action: 'pop' }] },
    { type: 'mock', from: 3, to: 3, headline: h('d'), mock: { kind: 'bars', items: [{ text: 'x', sentence: 3 }] } },
    { type: 'mock', from: 4, to: 4, headline: h('e'), mock: { kind: 'checklist', items: [{ text: 'y', sentence: 4 }] } },
    { type: 'statement', from: 5, to: 5, headline: h('f'), lines: ['سطر واحد'] },
    { type: 'cta', from: 6, to: 6, headline: h('g') },
  ] as never);
  assert.deepEqual(out.map((p) => p.type), ['hook', 'story', 'story', 'mock', 'mock', 'mock', 'cta'], 'statement/empty screen with objects → story; screens in a row stay separate; lines → checklist');
});
