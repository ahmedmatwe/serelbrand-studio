import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { batchScenes, cutPoints, splitBatch } from '../../src/media/voice-batch.ts';
import { ffmpeg, probeDuration } from '../../src/media/ffmpeg.ts';
import { quotaResetSeconds } from '../../src/providers/tts/gemini-tts.ts';

const w = (n: number) => ({ voiceover: Array(n).fill('كلمة').join(' ') });

test('voice batch: a long video fits in few TTS requests, scenes stay in order', () => {
  const scenes = [w(150), w(160), w(140), w(170), w(150), w(160), w(150), w(140), w(150), w(130)];
  const groups = batchScenes(scenes);
  assert.ok(groups.length <= 3, `${groups.length} batches`);
  assert.deepEqual(groups.flat(), scenes);
  assert.equal(batchScenes([w(100), w(100), w(100)]).length, 1, 'a Shorts pack is one request');
});

test('voice batch: cuts snap to the nearest pause, else proportional', () => {
  assert.deepEqual(cutPoints(['a b', 'c d'], 10, [5.4]), [5.4]);
  assert.deepEqual(cutPoints(['a b', 'c d'], 10, [9.5]), [5]);
});

test('voice batch: splits real audio at the silence between scenes', async () => {
  const d = mkdtempSync(join(tmpdir(), 'vb-'));
  try {
    const src = join(d, 'batch.wav');
    await ffmpeg(['-f', 'lavfi', '-i', 'sine=f=300:d=3', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=0.8', '-f', 'lavfi', '-i', 'sine=f=500:d=3',
      '-filter_complex', '[1]atrim=duration=0.8[s];[0][s][2]concat=n=3:v=0:a=1', '-ac', '1', src]);
    const outs = [join(d, 'a.wav'), join(d, 'b.wav')];
    await splitBatch(src, ['واحد اتنين تلاتة', 'أربعة خمسة ستة'], outs);
    const [a, b] = [await probeDuration(outs[0]!), await probeDuration(outs[1]!)];
    assert.ok(Math.abs(a - 3.4) < 0.3, `first part ${a}`);
    assert.ok(Math.abs(b - 3.4) < 0.3, `second part ${b}`);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('tts quota: reset time parsed from Google message', () => {
  assert.equal(quotaResetSeconds('Please retry in 11h37m27.68s.'), 11 * 3600 + 37 * 60 + 28);
  assert.equal(quotaResetSeconds('Please retry in 45s'), 45);
  assert.equal(quotaResetSeconds('no hint'), 12 * 3600);
});
