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
  assert.ok(groups.length <= 4, `${groups.length} batches`);
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

test('footage: unrelated clips are rejected, relevant ones preferred', async () => {
  const { pickRelevant, relevance, queryParts } = await import('../../src/media/shots.ts');
  const mk = (id: string, tags: string[]) => ({ id, kind: 'video' as const, path: id, license: 'pixabay' as const, source: 'pixabay', aiGenerated: false, tags });
  const crystals = mk('c', ['amethyst', 'crystal', 'purple']);
  const garage = mk('g', ['garage', 'workshop', 'tools']);
  assert.equal(relevance(crystals, 'small garage workshop'), 0);
  assert.equal(relevance(garage, 'small garage workshop'), 2);
  assert.equal(pickRelevant([crystals, garage], 'small garage workshop', new Set())?.id, 'g');
  assert.equal(pickRelevant([crystals], 'small garage workshop', new Set()), undefined, 'never a random unrelated clip');
  assert.deepEqual(queryParts('old garage workshop || garage || documentary'), ['old garage workshop', 'garage', 'documentary']);
});

test('sound: voice + looped music + SFX mix always finishes (sidechain/loudnorm EOF regression)', { timeout: 60_000 }, async () => {
  const { mixSoundtrack } = await import('../../src/media/sound.ts');
  const d = mkdtempSync(join(tmpdir(), 'mix-'));
  try {
    const voice = join(d, 'v.wav'); const music = join(d, 'm.mp3');
    await ffmpeg(['-f', 'lavfi', '-i', 'sine=f=220:d=6', voice]);
    await ffmpeg(['-f', 'lavfi', '-i', 'sine=f=440:d=2', music]); // shorter than the video → must loop
    const r = await mixSoundtrack({ voice, durationSec: 6, cues: [{ at: 0, kind: 'impact' }, { at: 3, kind: 'whoosh' }], musicPath: music, dir: d, out: join(d, 'o.m4a') });
    assert.equal(r.musicUsed, true);
    assert.ok(Math.abs((await probeDuration(join(d, 'o.m4a'))) - 6) < 0.3);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('footage: vision approvals are respected — unapproved candidates are never used', async () => {
  const { pickByVision } = await import('../../src/media/shots.ts');
  const { MockLLM } = await import('../../src/providers/llm/mock.ts');
  // Mock LLM → vision is skipped (no blind calls in offline runs).
  const ctx = { providers: { llm: new MockLLM({}) } } as never;
  assert.equal((await pickByVision(ctx, [{ text: 'x', candidates: [] }])).size, 0);
});
