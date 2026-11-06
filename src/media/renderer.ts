import { mkdirSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Agent } from '../agents/base.ts';
import type { Blueprint, Script } from '../agents/schemas.ts';
import type { ThumbnailOutput } from '../agents/thumbnail.ts';
import { StudioError } from '../core/errors.ts';
import type { MediaAsset, TTSProvider } from '../providers/media.ts';
import { FallbackTTS } from '../providers/tts/gemini-tts.ts';
import { buildAss, chunkSubtitles, type AssEvent, type AssStyle } from './ass.ts';
import { ffmpeg, filterPath, probeDuration, volumeStats, type VolumeStats } from './ffmpeg.ts';

export type RenderSize = 'full' | 'preview';
export interface RenderInput { videoId: string; size?: RenderSize; shorts?: boolean; /** Shorts to cut per long video (default 3). */ shortsPerLong?: number }

export interface SceneVisual { kind: 'video' | 'image'; path: string; asset: MediaAsset }
interface TimedScene { n: number; start: number; duration: number; audioPath: string; voiceover: string; onScreenText: string; visual?: SceneVisual }

export interface RenderedShort { path: string; durationSec: number; scenes: number[]; title: string }

export interface RenderOutput {
  videoPath: string;
  thumbnailPath: string;
  captionsPath: string;
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
    { name: 'Sub', font: FONT, size: Math.round(base * (vertical ? 0.06 : 0.048)), color: '#FFFFFF', outline: '#000000', outlineWidth: Math.max(2, Math.round(base * 0.004)), alignment: 2, marginV: Math.round(o.height * (vertical ? 0.2 : 0.07)), boxed: false },
  ];
  const events: AssEvent[] = [];
  const subs: { start: number; end: number; text: string }[] = [];
  for (const s of scenes) {
    if (s.onScreenText) events.push({ start: s.start + 0.2, end: s.start + Math.min(s.duration - 0.1, 5), style: 'Title', text: s.onScreenText, fadeMs: 300 });
    const chunks = chunkSubtitles(s.voiceover, s.start, s.duration - 0.35, vertical ? 6 : 9);
    subs.push(...chunks);
    events.push(...chunks.map((c) => ({ ...c, style: 'Sub' })));
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
export function sceneGraph(scenes: TimedScene[], o: { width: number; height: number; palette: string[] }) {
  const { width: W, height: H } = o;
  const inputs: string[] = [];
  const parts: string[] = [];
  scenes.forEach((s, i) => {
    const d = s.duration.toFixed(3);
    const frames = Math.ceil(s.duration * 30);
    const tone = 'eq=brightness=-0.09:saturation=0.92,setsar=1,format=yuv420p';
    if (s.visual?.kind === 'video') {
      inputs.push('-stream_loop', '-1', '-t', d, '-i', s.visual.path);
      parts.push(`[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=30,trim=duration=${d},setpts=PTS-STARTPTS,${tone}[s${i}]`);
    } else if (s.visual?.kind === 'image') {
      inputs.push('-loop', '1', '-framerate', '30', '-t', d, '-i', s.visual.path);
      parts.push(`[${i}:v]scale=${Math.round(W * 1.25)}:${Math.round(H * 1.25)}:force_original_aspect_ratio=increase,crop=${Math.round(W * 1.25)}:${Math.round(H * 1.25)},zoompan=z='min(1+0.0006*on,1.2)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=30,trim=end_frame=${frames},setpts=PTS-STARTPTS,${tone}[s${i}]`);
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
    const { inputs, filter } = sceneGraph(scenes, o);
    await ffmpeg([
      ...inputs,
      '-i', audioPath,
      '-filter_complex', `${filter},subtitles=filename='${filterPath(o.assPath)}'[v]`,
      '-map', '[v]', '-map', `${scenes.length}:a`,
      '-c:v', 'libx264', '-preset', o.preset, '-crf', '21', '-pix_fmt', 'yuv420p', '-r', '30',
      '-c:a', 'aac', '-b:a', '160k', '-ar', '48000',
      '-shortest', '-movflags', '+faststart',
      out,
    ]);
    return subs;
  }

  private async renderPack(o: { videoId: string; dir: string; timed: TimedScene[]; t: number; size: RenderSize; palette: string[]; preset: string; notes: string[]; tts: TTSProvider; voiceName: string; th: ThumbnailOutput }): Promise<RenderOutput> {
    const bp = this.ctx.repos.artifacts.latest<Blueprint>(o.videoId, 'blueprint')!.data;
    const script = this.ctx.repos.artifacts.latest<Script>(o.videoId, 'script')!.data;
    const visuals = await this.fetchVisuals(bp, o.size, o.notes);
    const shorts: RenderedShort[] = [];
    for (const s of o.timed) {
      s.visual = visuals.get(s.n);
      const d = Math.min(s.duration, SHORT_MAX_SEC + 1);
      if (s.duration > SHORT_MAX_SEC + 1) o.notes.push(`Scene ${s.n} is ${Math.round(s.duration)}s — trimmed to ${SHORT_MAX_SEC + 1}s`);
      const audio = resolve(o.dir, `short-${s.n}.m4a`);
      await ffmpeg(['-i', s.audioPath, '-t', String(d), '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-ar', '48000', '-c:a', 'aac', '-b:a', '160k', audio]);
      const path = resolve(o.dir, `short-${s.n}.mp4`);
      await this.renderTimeline([{ ...s, start: 0, duration: d }], audio, path, { ...dims(o.size, true), palette: o.palette, preset: o.preset, endCard: 'تابع القناة لسر جديد كل يوم', assPath: resolve(o.dir, `short-${s.n}.ass`) });
      const sc = script.scenes.find((x) => x.n === s.n);
      shorts.push({ path, durationSec: Number(d.toFixed(2)), scenes: [s.n], title: sc?.curiosityGap || sc?.onScreenText || script.mainTitle });
    }
    const first = shorts[0]!;
    const audio = await volumeStats(resolve(o.dir, `short-${o.timed[0]!.n}.m4a`));
    const silent = !Number.isFinite(audio.meanDb) || audio.meanDb < -50;
    const assets: MediaAsset[] = [
      { id: 'voice', kind: 'voice', path: o.dir, license: 'generated-owned', source: o.tts.name, aiGenerated: true },
      ...[...visuals.values()].map((v) => v.asset),
    ];
    return {
      videoPath: first.path, thumbnailPath: '', captionsPath: '',
      durationSec: first.durationSec, size: dims(o.size, true),
      scenes: o.timed.map(({ n, start, duration, audioPath, visual }) => ({ n, start: Number(start.toFixed(2)), duration: Number(duration.toFixed(2)), audioPath, visual: visual ? `${visual.kind}:${visual.asset.id}` : 'text-card' })),
      shorts, packOnly: true,
      voice: { provider: o.tts.name, voice: o.voiceName, synthetic: true },
      visualMode: visuals.size === 0 ? 'text-cards' : visuals.size === o.timed.length ? 'stock' : 'mixed',
      assets,
      measurements: { audio, audioScore: silent ? 0 : 85, visualScore: Math.round(55 + 25 * (visuals.size / Math.max(1, o.timed.length))), subtitleAccuracy: 100, avSyncDiffSec: 0, notes: o.notes },
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
      for (const s of bp.scenes) {
        const r = await provider.synthesize(s.voiceover, resolve(dir, `scene-${s.n}.aiff`));
        voiceName = r.voice;
        const wav = resolve(dir, `scene-${s.n}.wav`);
        if (existsSync(r.audioPath)) {
          await ffmpeg(['-i', r.audioPath, '-af', 'apad=pad_dur=0.45', '-ar', '48000', '-ac', '1', wav]);
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
    const visuals = await this.fetchVisuals(bp, size, notes);
    for (const s of timed) s.visual = visuals.get(s.n);
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
    const subs = await this.renderTimeline(timed, voice, videoPath, { ...main, palette, preset, assPath: resolve(dir, 'video.ass') });
    const captionsPath = resolve(dir, 'captions.srt');
    writeFileSync(captionsPath, toSrt(subs), 'utf8');

    // 4) Thumbnail PNG (1280x720) from the recommended concept.
    const thumbnailPath = resolve(dir, 'thumbnail.png');
    const thumbAss = resolve(dir, 'thumb.ass');
    writeFileSync(thumbAss, buildAss({
      width: 1280, height: 720,
      styles: [{ name: 'T', font: FONT, size: 140, color: palette[2] ?? '#FFD400', outline: '#000000', outlineWidth: 8, alignment: 5, marginV: 0, bold: true }],
      events: [{ start: 0, end: 5, style: 'T', text: concept.text }],
    }));
    await ffmpeg(['-f', 'lavfi', '-i', `gradients=s=1280x720:c0=${palette[0]!.replace('#', '0x')}:c1=${(palette[1] ?? '#000000').replace('#', '0x')}:d=1:seed=7`, '-vf', `subtitles=filename='${filterPath(thumbAss)}'`, '-frames:v', '1', '-update', '1', thumbnailPath]);
    notes.push(`Thumbnail is text-on-gradient; the concept visual ("${concept.mainVisual}") still needs an image.`);

    /** A vertical Short narrated from its own text, over the given scene's visual. */
    const narratedShort = async (k: number, text: string, scene: TimedScene, title: string): Promise<RenderedShort> => {
      const r = await tts.synthesize(text, resolve(dir, `short-${k}.aiff`));
      const wav = resolve(dir, `short-${k}.wav`);
      if (existsSync(r.audioPath)) await ffmpeg(['-i', r.audioPath, '-af', 'apad=pad_dur=0.6', '-ar', '48000', '-ac', '1', wav]);
      else await ffmpeg(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', String(Math.max(1, r.durationSec) + 0.6), wav]);
      const d = Math.min(await probeDuration(wav), SHORT_MAX_SEC + 1);
      const saudio = resolve(dir, `short-${k}.m4a`);
      await ffmpeg(['-i', wav, '-t', String(d), '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-ar', '48000', '-c:a', 'aac', '-b:a', '160k', saudio]);
      const one: TimedScene[] = [{ n: scene.n, start: 0, duration: d, audioPath: wav, voiceover: text, onScreenText: scene.onScreenText, visual: scene.visual }];
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
      // Extra Shorts: one per scene that carries a curiosity gap (each a self-contained mini-story).
      const used = new Set(shorts.flatMap((x) => x.scenes));
      const extra = script.scenes.filter((sc) => sc.curiosityGap && !used.has(sc.n)).slice(0, Math.max(0, (input.shortsPerLong ?? 3) - 1));
      for (const [i, sc] of extra.entries()) {
        const scene = timed.find((t) => t.n === sc.n);
        if (!scene) continue;
        try {
          shorts.push(await narratedShort(i + 2, shortScript(sc.curiosityGap!, sc.voiceover, 120), scene, sc.curiosityGap!));
        } catch (err) {
          notes.push(`Extra Short ${i + 2} skipped: ${(err as Error).message.slice(0, 100)}`);
        }
      }
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
    const stockShare = visuals.size / Math.max(1, timed.length);
    const visualScore = statSync(videoPath).size > 10_000 ? Math.round(55 + 25 * stockShare) : 0;
    if (stockShare < 1) notes.push(`${timed.length - visuals.size}/${timed.length} scenes use text cards on gradients (original, copyright-safe).`);
    if (visuals.size) notes.push(`${visuals.size} scenes use free stock footage — check none shows identifiable people/brands in a misleading way.`);
    notes.push('Subtitles are timed from the script, not speech recognition; they match because TTS reads the script verbatim.');

    const assets: MediaAsset[] = [
      { id: 'bg-gradients', kind: 'video', path: videoPath, license: 'generated-owned', source: 'ffmpeg-gradients', aiGenerated: false },
      { id: 'voice', kind: 'voice', path: voice, license: 'generated-owned', source: tts.name, aiGenerated: true },
      ...[...visuals.values()].map((v) => v.asset),
    ];
    return {
      videoPath, thumbnailPath, captionsPath,
      durationSec: Number(durationSec.toFixed(2)),
      size: main,
      scenes: timed.map(({ n, start, duration, audioPath, visual }) => ({ n, start: Number(start.toFixed(2)), duration: Number(duration.toFixed(2)), audioPath, visual: visual ? `${visual.kind}:${visual.asset.id}` : 'text-card' })),
      shorts,
      voice: { provider: tts.name, voice: voiceName, synthetic: true },
      visualMode: visuals.size === 0 ? 'text-cards' : visuals.size === timed.length ? 'stock' : 'mixed',
      assets,
      measurements: { audio, audioScore, visualScore, subtitleAccuracy, avSyncDiffSec, notes },
    };
  }
}
