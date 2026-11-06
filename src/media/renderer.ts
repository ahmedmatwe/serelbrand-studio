import { mkdirSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Agent } from '../agents/base.ts';
import type { Blueprint, Script } from '../agents/schemas.ts';
import type { ThumbnailOutput } from '../agents/thumbnail.ts';
import { StudioError } from '../core/errors.ts';
import type { MediaAsset, TTSProvider, TTSResult } from '../providers/media.ts';
import { batchScenes, splitBatch } from './voice-batch.ts';
import { FallbackTTS } from '../providers/tts/gemini-tts.ts';
import { buildAss, chunkSubtitles, type AssEvent, type AssStyle } from './ass.ts';
import { ffmpeg, filterPath, probeDuration, volumeStats, type VolumeStats } from './ffmpeg.ts';
import { fetchShotVisuals, layoutShots, queriesForSentences, splitSentences, type Shot } from './shots.ts';
import { renderThumbnail } from './thumbnail.ts';
import { cuesFor, mixSoundtrack, pickMusic } from './sound.ts';
import { z } from 'zod';

export type RenderSize = 'full' | 'preview';
export interface RenderInput { videoId: string; size?: RenderSize; shorts?: boolean; /** Shorts to cut per long video (default 3). */ shortsPerLong?: number }

export interface SceneVisual { kind: 'video' | 'image'; path: string; asset: MediaAsset }
interface TimedScene { n: number; start: number; duration: number; audioPath: string; voiceover: string; onScreenText: string; visual?: SceneVisual; shots?: Shot[] }
/** One background segment of the timeline (a shot, or a whole scene when it has no shots). */
interface Segment { n: number; duration: number; visual?: SceneVisual }

export interface RenderedShort { path: string; durationSec: number; scenes: number[]; title: string }

export interface RenderOutput {
  videoPath: string;
  thumbnailPath: string;
  captionsPath: string;
  captionsEnPath?: string;
  durationSec: number;
  size: { width: number; height: number };
  scenes: (Omit<TimedScene, 'voiceover' | 'onScreenText' | 'visual'> & { visual: string })[];
  shorts: RenderedShort[];
  /** Shorts pack: only the vertical Shorts exist (no 16:9 video). */
  packOnly?: boolean;
  voice: { provider: string; voice: string; synthetic: boolean };
  visualMode: 'text-cards' | 'stock' | 'mixed';
  assets: MediaAsset[];
  measurements: { audio: VolumeStats; audioScore: number; visualScore: number; subtitleAccuracy: number; avSyncDiffSec: number; notes: string[] };
}

// macOS ships Geeza Pro; on Linux/cloud runners use the free Noto Naskh Arabic (fonts-noto-core).
const FONT = process.env.ARABIC_FONT || (process.platform === 'darwin' ? 'Geeza Pro' : 'Noto Naskh Arabic');
const DEFAULT_PALETTE = ['#0B1E3F', '#1B3A6B', '#FFD400', '#FFFFFF'];
const SHORT_MAX_SEC = 58;

const dims = (size: RenderSize, vertical: boolean) => {
  const [w, h] = size === 'full' ? [1920, 1080] : [960, 540];
  return vertical ? { width: h, height: w } : { width: w, height: h };
};

/** Pure: builds the ASS subtitle document for a timeline (on-screen text + narration subtitles). */
export function timelineAss(scenes: TimedScene[], o: { width: number; height: number; accent: string; endCard?: string }) {
  const base = Math.min(o.width, o.height);
  const vertical = o.height > o.width;
  const styles: AssStyle[] = [
    { name: 'Title', font: FONT, size: Math.round(base * (vertical ? 0.085 : 0.09)), color: '#FFFFFF', outline: '#000000', outlineWidth: Math.max(2, Math.round(base * 0.005)), alignment: vertical ? 8 : 5, marginV: Math.round(o.height * (vertical ? 0.22 : 0.08)), bold: true },
    { name: 'Accent', font: FONT, size: Math.round(base * 0.05), color: o.accent, outline: '#000000', outlineWidth: 2, alignment: 8, marginV: Math.round(o.height * 0.06), bold: true },
    { name: 'Sub', font: FONT, size: Math.round(base * (vertical ? 0.085 : 0.062)), color: '#FFD400', secondary: '#FFFFFF', outline: '#000000', outlineWidth: Math.max(3, Math.round(base * 0.007)), shadow: 3, alignment: vertical ? 5 : 2, marginV: Math.round(o.height * (vertical ? 0.12 : 0.08)), bold: true },
  ];
  const events: AssEvent[] = [];
  const subs: { start: number; end: number; text: string }[] = [];
  for (const s of scenes) {
    if (s.onScreenText) events.push({ start: s.start + 0.2, end: s.start + Math.min(s.duration - 0.1, 5), style: 'Title', text: s.onScreenText, fadeMs: 300 });
    // Viral-style captions: short chunks, the word being spoken lights up (ASS karaoke).
    const chunks = chunkSubtitles(s.voiceover, s.start, s.duration - 0.35, vertical ? 4 : 6);
    subs.push(...chunks);
    events.push(...chunks.map((c) => ({ ...c, style: 'Sub', karaoke: true })));
  }
  if (o.endCard && scenes.length) {
    const last = scenes.at(-1)!;
    const end = last.start + last.duration;
    events.push({ start: Math.max(0, end - 2.5), end, style: 'Accent', text: o.endCard, fadeMs: 200 });
  }
  return { ass: buildAss({ width: o.width, height: o.height, styles, events }), subs };
}

const srtTime = (s: number) => {
  const ms = Math.round(s * 1000);
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor((ms % 3600000) / 60000))}:${p(Math.floor((ms % 60000) / 1000))},${p(ms % 1000, 3)}`;
};
export const toSrt = (subs: { start: number; end: number; text: string }[]) =>
  subs.map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${s.text}\n`).join('\n');

/** Hook + whole sentences from the narration, up to `maxWords` (≈ 50 s of speech). */
export function shortScript(hook: string, narration: string, maxWords: number): string {
  const out: string[] = hook.trim() ? [hook.trim()] : [];
  let words = hook.trim().split(/\s+/).filter(Boolean).length;
  for (const sentence of narration.match(/[^.!؟?]+[.!؟?]*/g) ?? []) {
    const w = sentence.trim().split(/\s+/).filter(Boolean).length;
    if (words + w > maxWords) break;
    out.push(sentence.trim());
    words += w;
  }
  return out.join(' ');
}

/** Picks the opening scenes (the hook) that fit in one Short. */
export function pickShortScenes(scenes: { n: number; duration: number }[], maxSec = SHORT_MAX_SEC): number[] {
  const out: number[] = [];
  let t = 0;
  for (const s of scenes) {
    if (t + s.duration > maxSec) break;
    out.push(s.n);
    t += s.duration;
  }
  return out;
}

/**
 * Pure: FFmpeg inputs + filtergraph for the scene backgrounds.
 * Stock video → cover-crop + loop; photo → slow Ken Burns zoom; none → animated gradient.
 * Footage is darkened slightly so the Arabic text stays readable.
 */
export function sceneGraph(scenes: Segment[], o: { width: number; height: number; palette: string[] }) {
  const { width: W, height: H } = o;
  const inputs: string[] = [];
  const parts: string[] = [];
  scenes.forEach((s, i) => {
    const d = s.duration.toFixed(3);
    const frames = Math.ceil(s.duration * 30);
    const tone = 'eq=brightness=-0.09:saturation=0.95:contrast=1.05,setsar=1,format=yuv420p';
    if (s.visual?.kind === 'video') {
      // Slow camera move on every clip (pan left→right, right→left, or push-in) so no shot is ever static.
      inputs.push('-stream_loop', '-1', '-t', d, '-i', s.visual.path);
      const BW = Math.round(W * 1.12), BH = Math.round(H * 1.12);
      const move = i % 3 === 0 ? `x='(iw-ow)*t/${d}':y='(ih-oh)/2'` : i % 3 === 1 ? `x='(iw-ow)*(1-t/${d})':y='(ih-oh)/2'` : `x='(iw-ow)/2':y='(ih-oh)*t/${d}'`;
      parts.push(`[${i}:v]fps=30,scale=${BW}:${BH}:force_original_aspect_ratio=increase,crop=${BW}:${BH},crop=${W}:${H}:${move},trim=duration=${d},setpts=PTS-STARTPTS,${tone}[s${i}]`);
    } else if (s.visual?.kind === 'image') {
      inputs.push('-loop', '1', '-framerate', '30', '-t', d, '-i', s.visual.path);
      const zin = i % 2 === 0;
      parts.push(`[${i}:v]scale=${Math.round(W * 1.25)}:${Math.round(H * 1.25)}:force_original_aspect_ratio=increase,crop=${Math.round(W * 1.25)}:${Math.round(H * 1.25)},zoompan=z='${zin ? 'min(1+0.0012*on,1.18)' : 'max(1.18-0.0012*on,1)'}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=30,trim=end_frame=${frames},setpts=PTS-STARTPTS,${tone}[s${i}]`);
    } else {
      const c0 = o.palette[i % 2] ?? DEFAULT_PALETTE[0]!;
      const c1 = o.palette[(i + 1) % 2] ?? DEFAULT_PALETTE[1]!;
      inputs.push('-f', 'lavfi', '-i', `gradients=s=${W}x${H}:r=30:c0=${c0.replace('#', '0x')}:c1=${c1.replace('#', '0x')}:speed=0.008:d=${d}:seed=${s.n}`);
      parts.push(`[${i}:v]setsar=1,format=yuv420p[s${i}]`);
    }
  });
  const filter = `${parts.join(';')};${scenes.map((_, i) => `[s${i}]`).join('')}concat=n=${scenes.length}:v=1:a=0`;
  return { inputs, filter };
}

/** Keeps the shots that fall inside the first `d` seconds (Shorts trimmed to 59 s). */
export function trimShots(shots: Shot[] | undefined, d: number): Shot[] | undefined {
  if (!shots) return shots;
  const out: Shot[] = [];
  for (const s of shots) { if (s.start >= d) break; out.push({ ...s, duration: Math.min(s.duration, d - s.start) }); }
  return out;
}
export const uniqueAssets = (shots: Shot[]) => [...new Map(shots.filter((s) => s.visual).map((s) => [s.visual!.asset.id, s.visual!.asset])).values()];
/** 55 for pure text cards → 95 when every shot has real footage and cuts are frequent. */
export function visualScoreFor(shots: Shot[]): number {
  if (!shots.length) return 55;
  const share = shots.filter((s) => s.visual).length / shots.length;
  const avg = shots.reduce((a, s) => a + s.duration, 0) / shots.length;
  return Math.round(55 + 30 * share + (avg <= 6 ? 10 : 0));
}

/** Expands scenes into background segments (one per shot). */
export function segmentsOf(scenes: TimedScene[]): Segment[] {
  return scenes.flatMap((s) => (s.shots?.length ? s.shots.map((sh) => ({ n: s.n, duration: sh.duration, visual: sh.visual ?? s.visual })) : [{ n: s.n, duration: s.duration, visual: s.visual }]));
}

/**
 * Renderer: TTS per scene → normalised voice track → animated gradient backgrounds →
 * Arabic on-screen text + subtitles (libass) → H.264/AAC MP4. Plus a PNG thumbnail and vertical Shorts.
 * Everything is generated locally: no paid service, no third-party footage.
 */
export class RendererAgent extends Agent<RenderInput, RenderOutput> {
  readonly name = 'renderer';
  readonly artifactKind = 'render';

  private async renderTimeline(scenes: TimedScene[], audioPath: string, out: string, o: { width: number; height: number; palette: string[]; preset: string; endCard?: string; assPath: string }) {
    const { ass, subs } = timelineAss(scenes, { width: o.width, height: o.height, accent: o.palette[2] ?? '#FFD400', endCard: o.endCard });
    writeFileSync(o.assPath, ass, 'utf8');
    // Render the background in chunks of ≤ 20 shots (keeps FFmpeg graphs small), then concat losslessly.
    const segs = segmentsOf(scenes);
    const parts: string[] = [];
    for (let i = 0; i < segs.length; i += 20) {
      const { inputs, filter } = sceneGraph(segs.slice(i, i + 20), o);
      const part = `${out}.part${String(parts.length).padStart(3, '0')}.mp4`;
      await ffmpeg([...inputs, '-filter_complex', `${filter}[v]`, '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '17', '-pix_fmt', 'yuv420p', '-r', '30', '-an', part]);
      parts.push(part);
    }
    const list = `${out}.parts.txt`;
    writeFileSync(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
    await ffmpeg([
      '-f', 'concat', '-safe', '0', '-i', list,
      '-i', audioPath,
      '-vf', `subtitles=filename='${filterPath(o.assPath)}'`,
      '-map', '0:v', '-map', '1:a',
      '-c:v', 'libx264', '-preset', o.preset, '-crf', '21', '-pix_fmt', 'yuv420p', '-r', '30',
      '-c:a', 'aac', '-b:a', '160k', '-ar', '48000',
      '-shortest', '-movflags', '+faststart',
      out,
    ]);
    for (const p of [...parts, list]) rmSync(p, { force: true });
    return subs;
  }

  private async translateCaptions(videoId: string, subs: { start: number; end: number; text: string }[], out: string, notes: string[]): Promise<string | undefined> {
    if (!subs.length) return undefined;
    const lines: string[] = [];
    for (let i = 0; i < subs.length; i += 80) {
      const batch = subs.slice(i, i + 80).map((x) => x.text);
      const r = await this.ctx.providers.llm.generateJson({
        task: 'captions.translate',
        tier: 'light',
        system: 'Translate each Arabic caption line into short, natural English subtitles. Keep the same number of lines and order. Do not add or remove information. Output JSON only.',
        prompt: JSON.stringify({ lines: batch }),
        schema: z.object({ lines: z.array(z.string()) }),
        vars: { lines: batch },
        videoId,
      }).catch(() => undefined);
      if (!r || r.data.lines.length !== batch.length) { notes.push('English captions skipped (translation mismatch).'); return undefined; }
      lines.push(...r.data.lines);
    }
    writeFileSync(out, toSrt(subs.map((x, i) => ({ ...x, text: lines[i]! }))), 'utf8');
    return out;
  }

  /** One stock clip per sentence for every scene (queries from the LLM, clips never reused when avoidable). */
  private async planShots(videoId: string, scenes: TimedScene[], bp: Blueprint, size: RenderSize, notes: string[], used: Set<string>) {
    const perScene = scenes.map((s) => splitSentences(s.voiceover));
    const fallbacks = scenes.flatMap((s, i) => perScene[i]!.map(() => { const b = bp.scenes.find((x) => x.n === s.n); return b?.stockQuery || b?.footage || 'documentary'; }));
    const queries = await queriesForSentences(this.ctx, perScene.flat(), fallbacks, videoId);
    let k = 0;
    for (const [i, s] of scenes.entries()) {
      const sentences = perScene[i]!.map((text) => ({ text, query: queries[k++]! }));
      s.shots = layoutShots(sentences.length ? sentences : [{ text: s.voiceover, query: fallbacks[0] ?? 'documentary' }], s.duration);
    }
    await fetchShotVisuals(this.ctx, scenes.flatMap((s) => s.shots ?? []), { targetWidth: size === 'full' ? 1280 : 960, orientation: 'landscape', cacheDir: resolve(this.ctx.config.rootDir, 'data/stock-cache'), used, notes });
    for (const s of scenes) s.visual = s.shots?.find((x) => x.visual)?.visual;
  }

  private async renderPack(o: { videoId: string; dir: string; timed: TimedScene[]; t: number; size: RenderSize; palette: string[]; preset: string; notes: string[]; tts: TTSProvider; voiceName: string; th: ThumbnailOutput }): Promise<RenderOutput> {
    const bp = this.ctx.repos.artifacts.latest<Blueprint>(o.videoId, 'blueprint')!.data;
    const script = this.ctx.repos.artifacts.latest<Script>(o.videoId, 'script')!.data;
    await this.planShots(o.videoId, o.timed, bp, o.size, o.notes, new Set());
    const shots = o.timed.flatMap((s) => s.shots ?? []);
    const shorts: RenderedShort[] = [];
    for (const s of o.timed) {
      const d = Math.min(s.duration, SHORT_MAX_SEC + 1);
      if (s.duration > SHORT_MAX_SEC + 1) o.notes.push(`Scene ${s.n} is ${Math.round(s.duration)}s — trimmed to ${SHORT_MAX_SEC + 1}s`);
      const audio = resolve(o.dir, `short-${s.n}.m4a`);
      await ffmpeg(['-i', s.audioPath, '-t', String(d), '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-ar', '48000', '-c:a', 'aac', '-b:a', '160k', audio]);
      const path = resolve(o.dir, `short-${s.n}.mp4`);
      await this.renderTimeline([{ ...s, start: 0, duration: d, shots: trimShots(s.shots, d) }], audio, path, { ...dims(o.size, true), palette: o.palette, preset: o.preset, endCard: 'تابع القناة لسر جديد كل يوم', assPath: resolve(o.dir, `short-${s.n}.ass`) });
      const sc = script.scenes.find((x) => x.n === s.n);
      shorts.push({ path, durationSec: Number(d.toFixed(2)), scenes: [s.n], title: sc?.curiosityGap || sc?.onScreenText || script.mainTitle });
    }
    const first = shorts[0]!;
    const audio = await volumeStats(resolve(o.dir, `short-${o.timed[0]!.n}.m4a`));
    const silent = !Number.isFinite(audio.meanDb) || audio.meanDb < -50;
    const assets: MediaAsset[] = [
      { id: 'voice', kind: 'voice', path: o.dir, license: 'generated-owned', source: o.tts.name, aiGenerated: true },
      ...uniqueAssets(shots),
    ];
    const withStock = shots.filter((x) => x.visual).length;
    return {
      videoPath: first.path, thumbnailPath: '', captionsPath: '',
      durationSec: first.durationSec, size: dims(o.size, true),
      scenes: o.timed.map(({ n, start, duration, audioPath, visual }) => ({ n, start: Number(start.toFixed(2)), duration: Number(duration.toFixed(2)), audioPath, visual: visual ? `${visual.kind}:${visual.asset.id}` : 'text-card' })),
      shorts, packOnly: true,
      voice: { provider: o.tts.name, voice: o.voiceName, synthetic: true },
      visualMode: withStock === 0 ? 'text-cards' : withStock === shots.length ? 'stock' : 'mixed',
      assets,
      measurements: { audio, audioScore: silent ? 0 : 85, visualScore: visualScoreFor(shots), subtitleAccuracy: 100, avSyncDiffSec: 0, notes: o.notes },
    };
  }

  /** Finds and downloads one stock clip (or photo) per scene. Never reuses a clip; failures fall back to text cards. */
  private async fetchVisuals(bp: Blueprint, size: RenderSize, notes: string[]): Promise<Map<number, SceneVisual>> {
    const stock = this.ctx.providers.stock;
    const out = new Map<number, SceneVisual>();
    if (!stock.download) return out;
    const cache = resolve(this.ctx.config.rootDir, 'data/stock-cache');
    const used = new Set<string>();
    const targetWidth = size === 'full' ? 1920 : 960;
    for (const s of bp.scenes) {
      const query = (s.stockQuery || s.footage).trim();
      if (!query) continue;
      try {
        let pick: MediaAsset | undefined;
        for (const kind of ['video', 'image'] as const) {
          const results = await stock.search(query, kind, { orientation: 'landscape', targetWidth, perPage: 10 });
          pick = results.find((r) => !used.has(r.id) && (kind === 'image' || (r.width ?? 0) >= 1280 || size === 'preview'));
          if (pick) break;
        }
        if (!pick) { notes.push(`Scene ${s.n}: no stock result for "${query}" — text card used`); continue; }
        used.add(pick.id);
        const path = await stock.download(pick, cache);
        out.set(s.n, { kind: pick.kind === 'video' ? 'video' : 'image', path, asset: { ...pick, path } });
      } catch (err) {
        notes.push(`Scene ${s.n}: stock failed (${(err as Error).message}) — text card used`);
      }
    }
    return out;
  }

  protected async execute(input: RenderInput): Promise<RenderOutput> {
    const { videoId } = input;
    const size = input.size ?? 'full';
    const script = this.ctx.repos.artifacts.latest<Script>(videoId, 'script')?.data;
    const bp = this.ctx.repos.artifacts.latest<Blueprint>(videoId, 'blueprint')?.data;
    const th = this.ctx.repos.artifacts.latest<ThumbnailOutput>(videoId, 'thumbnails')?.data;
    if (!script || !bp || !th) throw new StudioError('MISSING_INPUT', 'Render needs script, blueprint and thumbnails — run the earlier steps first');

    const dir = resolve(this.ctx.config.rootDir, 'data/renders', videoId);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const concept = th.concepts[th.recommendedIndex] ?? th.concepts[0]!;
    const palette = [...concept.palette, ...DEFAULT_PALETTE].filter((c) => /^#[0-9a-f]{6}$/i.test(c));
    const preset = size === 'full' ? 'veryfast' : 'ultrafast';
    const notes: string[] = [];

    // 1) Voice-over per scene → WAV with a short breath pause. If the primary voice fails part-way,
    //    the whole video is re-voiced with the fallback so voices never mix.
    let tts: TTSProvider = this.ctx.providers.tts;
    let timed: TimedScene[];
    let t = 0;
    let voiceName = '';
    const voiceAll = async (provider: TTSProvider) => {
      const out: TimedScene[] = [];
      let start = 0;
      // Gemini's free tier allows ~10 voice requests a day: voice scenes in a few batches, then split.
      const pre = new Map<number, TTSResult>();
      if (provider.name.startsWith('gemini')) {
        for (const [bi, group] of batchScenes(bp.scenes).entries()) {
          const dirs = group.map((g) => script.scenes.find((x) => x.n === g.n)?.delivery);
          const direction = { tone: dirs[0]?.tone, pace: dirs[0]?.pace, emphasis: dirs.flatMap((d) => d?.emphasis ?? []).slice(0, 6) };
          const r = await provider.synthesize(group.map((g) => g.voiceover).join('\n\n'), resolve(dir, `batch-${bi + 1}.aiff`), direction);
          const parts = group.map((g) => resolve(dir, `scene-${g.n}.batch.wav`));
          await splitBatch(r.audioPath, group.map((g) => g.voiceover), parts);
          group.forEach((g, i) => pre.set(g.n, { audioPath: parts[i]!, durationSec: 0, characters: g.voiceover.length, voice: r.voice }));
        }
      }
      for (const s of bp.scenes) {
        const sc = script.scenes.find((x) => x.n === s.n);
        let r = pre.get(s.n) ?? await provider.synthesize(s.voiceover, resolve(dir, `scene-${s.n}.aiff`), sc?.delivery);
        // Stage gate: a scene whose audio is silent, cut off or stretched is re-recorded right away (up to 2x).
        for (let attempt = 0; attempt < 2 && existsSync(r.audioPath) && !provider.name.startsWith('mock'); attempt++) {
          const problem = await sceneAudioProblem(r.audioPath, s.voiceover, this.ctx.config.thresholds.script.arabicWordsPerMinute);
          if (!problem) break;
          this.ctx.logger.child('renderer').warn('re-recording scene audio', { videoId, scene: s.n, problem });
          r = await provider.synthesize(s.voiceover, resolve(dir, `scene-${s.n}-retry${attempt + 1}.aiff`), sc?.delivery);
        }
        voiceName = r.voice;
        const wav = resolve(dir, `scene-${s.n}.wav`);
        if (existsSync(r.audioPath)) {
          // Dramatic silence after big lines; a normal breath otherwise.
          await ffmpeg(['-i', r.audioPath, '-af', `apad=pad_dur=${sc?.delivery?.pauseAfter ? 1.1 : 0.45}`, '-ar', '48000', '-ac', '1', wav]);
        } else {
          // Mock TTS produces no file: use silence of the estimated length so the pipeline is still exercised.
          await ffmpeg(['-f', 'lavfi', '-i', `anullsrc=r=48000:cl=mono`, '-t', String(Math.max(1, r.durationSec) + 0.45), wav]);
        }
        const duration = await probeDuration(wav);
        out.push({ n: s.n, start, duration, audioPath: wav, voiceover: s.voiceover, onScreenText: s.onScreenText });
        start += duration;
        this.ctx.cost.record({ provider: provider.name, operation: 'tts', videoId, units: r.characters, unit: 'characters', usd: 0 });
      }
      return { out, total: start };
    };
    try {
      const v = await voiceAll(tts);
      timed = v.out; t = v.total;
    } catch (err) {
      if (!(tts instanceof FallbackTTS)) throw err;
      notes.push(`Primary voice failed (${(err as Error).message.slice(0, 120)}) — whole video re-voiced with ${tts.fallback.name}.`);
      tts = tts.fallback;
      const v = await voiceAll(tts);
      timed = v.out; t = v.total;
    }
    if (!existsSync(timed[0]!.audioPath)) throw new StudioError('TTS_FAILED', 'No audio produced');
    const usedClips = new Set<string>();
    await this.planShots(videoId, timed, bp, size, notes, usedClips);
    const allShots = () => timed.flatMap((s) => s.shots ?? []);
    if (tts.name.startsWith('mock')) notes.push('Mock TTS: voice track is silence (set TTS_PROVIDER=macos and DRY_RUN=false for real speech).');

    // Shorts pack: every scene becomes its own vertical Short; no 16:9 video, no captions file.
    if (script.format === 'short') return this.renderPack({ videoId, dir, timed, t, size, palette, preset, notes, tts, voiceName, th });

    // 2) One loudness-normalised voice track (≈ -16 LUFS, YouTube-friendly).
    const list = resolve(dir, 'voice.txt');
    writeFileSync(list, timed.map((s) => `file '${s.audioPath.replace(/'/g, "'\\''")}'`).join('\n'));
    const voice = resolve(dir, 'voice.m4a');
    await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', '48000', '-c:a', 'aac', '-b:a', '160k', voice]);

    // 3) Main 16:9 video.
    const main = dims(size, false);
    const videoPath = resolve(dir, 'video.mp4');
    // Sound design: whooshes on scene changes, impacts on reveals, optional ducked music bed from music/.
    const soundtrack = resolve(dir, 'soundtrack.m4a');
    const musicPath = pickMusic(resolve(this.ctx.config.rootDir, 'music'), bp.music.mood + ' ' + (script.scenes[0]?.delivery?.tone ?? ''), script.mainTitle.length);
    const beats = timed.map((s) => ({ start: s.start, beat: script.scenes.find((x) => x.n === s.n)?.beat }));
    const mix = await mixSoundtrack({ voice, durationSec: t, cues: cuesFor(beats), musicPath, dir, out: soundtrack });
    notes.push(mix.musicUsed ? `Music bed: ${musicPath!.split('/').pop()} (ducked under the voice).` : 'No music bed (add licensed tracks to music/). SFX added.');
    const subs = await this.renderTimeline(timed, soundtrack, videoPath, { ...main, palette, preset, assPath: resolve(dir, 'video.ass') });
    const captionsPath = resolve(dir, 'captions.srt');
    writeFileSync(captionsPath, toSrt(subs), 'utf8');
    // Second caption track in English (same timings) so non-Arabic viewers and search can use it.
    const captionsEnPath = await this.translateCaptions(videoId, subs, resolve(dir, 'captions.en.srt'), notes);

    // 4) Thumbnail PNG (1280x720): real photo + big outlined text + attention ring + channel badge.
    const thumb = await renderThumbnail(this.ctx, { dir, videoId, concept, title: script.mainTitle, palette, font: FONT, used: usedClips, notes });
    const thumbnailPath = thumb.path;

    const extraShots: Shot[] = [];
    /** A vertical Short narrated from its own text, with one clip per sentence. */
    const narratedShort = async (k: number, text: string, scene: TimedScene, title: string): Promise<RenderedShort> => {
      const r = await tts.synthesize(text, resolve(dir, `short-${k}.aiff`));
      const wav = resolve(dir, `short-${k}.wav`);
      if (existsSync(r.audioPath)) await ffmpeg(['-i', r.audioPath, '-af', 'apad=pad_dur=0.6', '-ar', '48000', '-ac', '1', wav]);
      else await ffmpeg(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', String(Math.max(1, r.durationSec) + 0.6), wav]);
      const d = Math.min(await probeDuration(wav), SHORT_MAX_SEC + 1);
      const saudio = resolve(dir, `short-${k}.m4a`);
      await ffmpeg(['-i', wav, '-t', String(d), '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-ar', '48000', '-c:a', 'aac', '-b:a', '160k', saudio]);
      const sentences = splitSentences(text);
      const qs = await queriesForSentences(this.ctx, sentences, bp.scenes.find((x) => x.n === scene.n)?.stockQuery || 'documentary', videoId);
      const shortShots = layoutShots(sentences.map((t2, i) => ({ text: t2, query: qs[i]! })), d);
      await fetchShotVisuals(this.ctx, shortShots, { targetWidth: size === 'full' ? 1280 : 960, orientation: 'landscape', cacheDir: resolve(this.ctx.config.rootDir, 'data/stock-cache'), used: usedClips, notes });
      extraShots.push(...shortShots);
      const one: TimedScene[] = [{ n: scene.n, start: 0, duration: d, audioPath: wav, voiceover: text, onScreenText: scene.onScreenText, visual: shortShots.find((x) => x.visual)?.visual ?? scene.visual, shots: shortShots }];
      const path = resolve(dir, `short-${k}.mp4`);
      await this.renderTimeline(one, saudio, path, { ...dims(size, true), palette, preset, endCard: 'القصة كاملة على القناة', assPath: resolve(dir, `short-${k}.ass`) });
      this.ctx.cost.record({ provider: tts.name, operation: 'tts.short', videoId, units: text.length, unit: 'characters', usd: 0 });
      return { path, durationSec: Number(d.toFixed(2)), scenes: [scene.n], title };
    };

    // 5) Vertical Short(s) from the hook.
    const shorts: RenderedShort[] = [];
    if (input.shorts !== false && script.format === 'long') {
      const picked = pickShortScenes(timed);
      if (picked.length) {
        const subset = timed.filter((s) => picked.includes(s.n));
        let st = 0;
        const reTimed = subset.map((s) => { const r = { ...s, start: st }; st += s.duration; return r; });
        const slist = resolve(dir, 'short-1.txt');
        writeFileSync(slist, subset.map((s) => `file '${s.audioPath.replace(/'/g, "'\\''")}'`).join('\n'));
        const saudio = resolve(dir, 'short-1.m4a');
        await ffmpeg(['-f', 'concat', '-safe', '0', '-i', slist, '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-ar', '48000', '-c:a', 'aac', '-b:a', '160k', saudio]);
        const path = resolve(dir, 'short-1.mp4');
        await this.renderTimeline(reTimed, saudio, path, { ...dims(size, true), palette, preset, endCard: 'القصة كاملة على القناة', assPath: resolve(dir, 'short-1.ass') });
        shorts.push({ path, durationSec: Number(st.toFixed(2)), scenes: picked, title: script.hooks[0] ?? script.mainTitle });
      } else {
        // Opening scene too long: narrate the hook + the first sentences as a dedicated Short.
        shorts.push(await narratedShort(1, shortScript(script.hooks[0] ?? '', timed.map((s) => s.voiceover).join(' '), 120), timed[0]!, script.hooks[0] ?? script.mainTitle));
      }
      // Always 3 Shorts per long video: scenes with a curiosity gap first, then reveal/escalation beats,
      // then any other scene — each narrated as a self-contained mini-story with its own hook.
      const want = input.shortsPerLong ?? 3;
      const used = new Set(shorts.flatMap((x) => x.scenes));
      const rank = (sc: Script['scenes'][number]) => (sc.curiosityGap ? 0 : sc.beat === 'reveal' ? 1 : sc.beat === 'escalation' ? 2 : 3);
      const candidates = script.scenes.filter((sc) => !used.has(sc.n) && sc.beat !== 'cta' && countWordsSimple(sc.voiceover) >= 40).sort((a, b) => rank(a) - rank(b));
      const spareHooks = script.hooks.slice(1);
      for (const sc of candidates) {
        if (shorts.length >= want) break;
        const scene = timed.find((t) => t.n === sc.n);
        if (!scene) continue;
        const hook = sc.curiosityGap || spareHooks.shift() || sc.onScreenText || script.mainTitle;
        try {
          shorts.push(await narratedShort(shorts.length + 1, shortScript(hook, sc.voiceover, 120), scene, hook));
        } catch (err) {
          notes.push(`Short from scene ${sc.n} skipped: ${(err as Error).message.slice(0, 100)}`);
        }
      }
      if (shorts.length < want) notes.push(`Only ${shorts.length}/${want} Shorts could be cut from this video.`);
    }

    // 6) Measurements (feed the Quality agent).
    const durationSec = await probeDuration(videoPath);
    const audio = await volumeStats(voice);
    const silent = !Number.isFinite(audio.meanDb) || audio.meanDb < -50;
    const audioScore = silent ? 0 : audio.maxDb > -0.5 ? 70 : audio.meanDb >= -30 && audio.meanDb <= -10 ? 85 : 70;
    if (!silent && tts.name === 'macos-say') notes.push(`Synthetic voice "${voiceName}" (macOS): clear but robotic.`);
    if (!silent && tts.name === 'gemini-tts') notes.push(`Natural AI voice "${voiceName}" (Gemini) — YouTube synthetic-content disclosure will be enabled to be safe.`);
    const subWords = subs.map((s) => s.text).join(' ').split(/\s+/).filter(Boolean);
    const voWords = timed.map((s) => s.voiceover).join(' ').split(/\s+/).filter(Boolean);
    const subtitleAccuracy = Math.round((Math.min(subWords.length, voWords.length) / Math.max(1, voWords.length)) * 100);
    const avSyncDiffSec = Number(Math.abs(durationSec - t).toFixed(2));
    if (avSyncDiffSec > 1) notes.push(`Video/audio length differ by ${avSyncDiffSec}s`);
    const shotsAll = [...allShots(), ...extraShots];
    const visualScore = statSync(videoPath).size > 10_000 ? visualScoreFor(allShots()) : 0;
    const withStock = allShots().filter((x) => x.visual).length;
    notes.push(`${allShots().length} shots (one per sentence, ~${(t / Math.max(1, allShots().length)).toFixed(1)}s each); ${withStock} with stock footage.`);
    if (withStock) notes.push('Stock footage used — check none shows identifiable people/brands in a misleading way.');
    notes.push('Subtitles are timed from the script, not speech recognition; they match because TTS reads the script verbatim.');

    const assets: MediaAsset[] = [
      { id: 'bg-gradients', kind: 'video', path: videoPath, license: 'generated-owned', source: 'ffmpeg-gradients', aiGenerated: false },
      { id: 'voice', kind: 'voice', path: voice, license: 'generated-owned', source: tts.name, aiGenerated: true },
      ...uniqueAssets(shotsAll),
      ...(thumb.asset ? [thumb.asset] : []),
    ];
    return {
      videoPath, thumbnailPath, captionsPath, captionsEnPath,
      durationSec: Number(durationSec.toFixed(2)),
      size: main,
      scenes: timed.map(({ n, start, duration, audioPath, visual }) => ({ n, start: Number(start.toFixed(2)), duration: Number(duration.toFixed(2)), audioPath, visual: visual ? `${visual.kind}:${visual.asset.id}` : 'text-card' })),
      shorts,
      voice: { provider: tts.name, voice: voiceName, synthetic: true },
      visualMode: withStock === 0 ? 'text-cards' : withStock === allShots().length ? 'stock' : 'mixed',
      assets,
      measurements: { audio, audioScore, visualScore, subtitleAccuracy, avSyncDiffSec, notes },
    };
  }
}

/** Why a narrated scene sounds broken (silent, cut off, or far too slow), or undefined when it is fine. */
export async function sceneAudioProblem(path: string, text: string, wordsPerMinute: number): Promise<string | undefined> {
  const [vol, dur] = await Promise.all([volumeStats(path), probeDuration(path)]);
  if (!Number.isFinite(vol.meanDb) || vol.meanDb < -45) return `silent (${vol.meanDb.toFixed(0)} dB)`;
  const expected = (text.trim().split(/\s+/).length / wordsPerMinute) * 60;
  if (expected > 3 && dur < expected * 0.45) return `cut off (${dur.toFixed(1)}s, expected ~${expected.toFixed(0)}s)`;
  if (expected > 3 && dur > expected * 2.5) return `stretched (${dur.toFixed(1)}s, expected ~${expected.toFixed(0)}s)`;
  return undefined;
}

const countWordsSimple = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;
