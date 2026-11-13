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
