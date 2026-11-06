import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { testContext, ROOT } from '../helpers.ts';
import { produceVideo } from '../../src/workflows/orchestrator.ts';
import { probeDuration } from '../../src/media/ffmpeg.ts';
import type { RenderOutput } from '../../src/media/renderer.ts';
import type { QualityReport } from '../../src/agents/quality.ts';
import type { ComplianceReport } from '../../src/agents/compliance.ts';

test('render: full chain produces MP4, Short, thumbnail, captions and feeds quality/compliance', { timeout: 300_000 }, async () => {
  const ctx = testContext();
  const r = await produceVideo(ctx, { title: 'قصة نوكيا', render: true, renderSize: 'preview' });
  assert.ok(r.steps.every((s) => s.status === 'succeeded'), JSON.stringify(r.steps.filter((s) => s.status !== 'succeeded')));
  const out = ctx.repos.artifacts.latest<RenderOutput>(r.videoId, 'render')!.data;
  try {
    for (const p of [out.videoPath, out.thumbnailPath, out.captionsPath, out.shorts[0]!.path]) assert.ok(existsSync(p), p);
    assert.deepEqual(out.size, { width: 960, height: 540 });
    const d = await probeDuration(out.videoPath);
    assert.ok(Math.abs(d - out.scenes.reduce((a, s) => a + s.duration, 0)) < 1, 'video length matches the voice track');
    assert.ok(out.shorts[0]!.durationSec <= 58);
    assert.equal(out.measurements.subtitleAccuracy, 100);
    assert.equal(out.measurements.audioScore, 0, 'mock TTS = silence, must score 0');
    assert.ok(out.assets.every((a) => a.license === 'generated-owned'));

    const q = ctx.repos.artifacts.latest<QualityReport>(r.videoId, 'quality_report')!.data;
    assert.equal(q.pendingRender, false);
    assert.equal(q.criteria.audioQuality!.score, 0);
    const c = ctx.repos.artifacts.latest<ComplianceReport>(r.videoId, 'compliance_report')!.data;
    assert.ok(!c.issues.some((i) => i.check === 'originality.ai_only'), 'renderer graphics count as original');
    assert.equal(c.copyrightStatus, 'clear');
  } finally {
    rmSync(resolve(ROOT, 'data/renders', r.videoId), { recursive: true, force: true });
    ctx.close();
  }
});

import { ffmpeg } from '../../src/media/ffmpeg.ts';
import type { MediaAsset, StockProvider } from '../../src/providers/media.ts';

/** Offline stand-in for Pexels: "downloads" by generating local test media with FFmpeg. */
class FakeStock implements StockProvider {
  readonly name = 'fake-pexels';
  async search(query: string, kind: 'image' | 'video'): Promise<MediaAsset[]> {
    if (query.includes('finland')) return []; // force one text-card fallback
    if (query.includes('chart') && kind === 'video') return []; // force one photo (Ken Burns) scene
    const id = `pexels-${kind}-${query.replace(/\W+/g, '-')}`;
    return [{ id, kind, path: `https://videos.pexels.com/${id}`, license: 'pexels', source: 'pexels', attribution: 'Test on Pexels', pageUrl: `https://www.pexels.com/${id}/`, width: 1280, height: 720, aiGenerated: false }];
  }
  async download(asset: MediaAsset, dir: string): Promise<string> {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
    const out = resolve(dir, `${asset.id}.${asset.kind === 'video' ? 'mp4' : 'png'}`);
    if (asset.kind === 'video') await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', out]);
    else await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=1280x720', '-frames:v', '1', '-update', '1', out]);
    return out;
  }
}

test('render: uses stock footage per scene (looping short clips), falls back to text cards, credits flow to compliance', { timeout: 300_000 }, async () => {
  const ctx = testContext();
  (ctx.providers as { stock: StockProvider }).stock = new FakeStock();
  const r = await produceVideo(ctx, { title: 'قصة نوكيا', render: true, renderSize: 'preview' });
  const out = ctx.repos.artifacts.latest<RenderOutput>(r.videoId, 'render')!.data;
  try {
    assert.ok(r.steps.every((s) => s.status === 'succeeded'), JSON.stringify(r.steps));
    assert.notEqual(out.visualMode, 'text-cards');
    const shotNote = out.measurements.notes.find((n) => /shots \(one per sentence/.test(n));
    assert.ok(shotNote, 'one shot per sentence');
    const nShots = Number(shotNote!.match(/^(\d+) shots/)![1]);
    assert.ok(nShots > out.scenes.length * 2, `cuts every few seconds (${nShots} shots for ${out.scenes.length} scenes)`);
    assert.ok(out.measurements.visualScore >= 85);
    assert.ok(out.assets.filter((a) => a.license === 'pexels').length >= 3, 'several distinct clips');
    const d = await probeDuration(out.videoPath);
    assert.ok(Math.abs(d - out.scenes.reduce((a, s) => a + s.duration, 0)) < 1, '3s clips loop to fill longer scenes');
    const c = ctx.repos.artifacts.latest<ComplianceReport>(r.videoId, 'compliance_report')!.data;
    assert.ok(c.issues.some((i) => i.check === 'rights.stock_review' && i.severity === 'low'));
    assert.equal(c.copyrightStatus, 'clear');
  } finally {
    if (process.env.KEEP_RENDER) console.log('kept', out.videoPath);
    else rmSync(resolve(ROOT, 'data/renders', r.videoId), { recursive: true, force: true });
    rmSync(resolve(ROOT, 'data/stock-cache'), { recursive: true, force: true });
    ctx.close();
  }
});

import { FallbackTTS } from '../../src/providers/tts/gemini-tts.ts';
import { MockTTS, type TTSProvider as TTSP } from '../../src/providers/media.ts';

test('render: if the primary voice fails mid-video, ALL scenes are re-voiced with the fallback', { timeout: 300_000 }, async () => {
  const ctx = testContext();
  let calls = 0;
  const flaky: TTSP = { name: 'gemini-tts', synthesize: async (text, out) => { if (++calls === 3) throw new Error('HTTP 429: quota'); return new MockTTS().synthesize(text, out); } };
  (ctx.providers as { tts: TTSP }).tts = new FallbackTTS(flaky, new MockTTS());
  const r = await produceVideo(ctx, { title: 'قصة نوكيا', render: true, renderSize: 'preview' });
  const out = ctx.repos.artifacts.latest<RenderOutput>(r.videoId, 'render')!.data;
  try {
    assert.ok(r.steps.every((s) => s.status === 'succeeded'));
    assert.equal(out.voice.provider, 'mock-tts', 'whole video uses the fallback voice');
    assert.ok(out.measurements.notes.some((n) => n.includes('re-voiced')));
  } finally {
    rmSync(resolve(ROOT, 'data/renders', r.videoId), { recursive: true, force: true });
    ctx.close();
  }
});

import { MockLLM as ML } from '../../src/providers/llm/mock.ts';
import { MOCK_FIXTURES as MF } from '../../src/providers/llm/fixtures.ts';

test('render: long scenes → hook Short + one extra Short per curiosity-gap scene', { timeout: 300_000 }, async () => {
  const long = (t: string) => Array(8).fill(t).join(' ');
  const base = MF['script.write']!({}) as { scenes: { voiceover: string }[] };
  const bp = MF['production.blueprint']!({}) as { scenes: { voiceover: string }[] };
  const fixtures = {
    ...MF,
    'script.write': () => ({ ...base, scenes: base.scenes.map((s) => ({ ...s, voiceover: long(s.voiceover) })) }),
    'production.blueprint': () => ({ ...bp, scenes: bp.scenes.map((s) => ({ ...s, voiceover: long(s.voiceover) })) }),
  };
  const ctx = testContext({ llm: new ML(fixtures) });
  const r = await produceVideo(ctx, { title: 'قصة نوكيا', render: true, renderSize: 'preview' });
  const out = ctx.repos.artifacts.latest<RenderOutput>(r.videoId, 'render')!.data;
  try {
    assert.equal(out.shorts.length, 2, JSON.stringify(out.measurements.notes));
    assert.ok(out.shorts.every((s) => s.durationSec <= 59));
    assert.deepEqual(out.shorts.map((s) => s.scenes[0]), [1, 3]);
  } finally {
    rmSync(resolve(ROOT, 'data/renders', r.videoId), { recursive: true, force: true });
    ctx.close();
  }
});
