import { mkdirSync, renameSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Agent } from '../agents/base.ts';
import type { Blueprint, Script } from '../agents/schemas.ts';
import type { ThumbnailOutput } from '../agents/thumbnail.ts';
import { StudioError } from '../core/errors.ts';
import type { MediaAsset, TTSProvider, TTSResult } from '../providers/media.ts';
import { batchScenes, splitBatch } from './voice-batch.ts';
import { lastAlignError, scriptWords, timedChunks, type WordTime } from './align.ts';
import { phoneUiEvents } from './phone-ui.ts';
import { loadPhoneLibrary, type PhoneSecret, type PhoneUi } from '../agents/niche/phone-library.ts';
import { FallbackTTS } from '../providers/tts/gemini-tts.ts';
import { buildAss, chunkSubtitles, type AssEvent, type AssStyle } from './ass.ts';
import { ffmpeg, filterPath, probeDuration, volumeStats, type VolumeStats } from './ffmpeg.ts';
import { auditFrames, critiqueEdit, fetchShotVisuals, layoutShots, queriesForSentences, queryParts, splitSentences, type Shot } from './shots.ts';
import { renderThumbnail } from './thumbnail.ts';
import { cuesFor, mixSoundtrackSafe, pickMusic } from './sound.ts';
import { z } from 'zod';
import { learnedMaxShot } from '../analytics/learner.ts';
import { motionAvailable, motionShare, planMotion, renderMotion, type MotionPlan } from './motion.ts';

export type RenderSize = 'full' | 'preview';
export interface RenderInput { videoId: string; size?: RenderSize; shorts?: boolean; /** Shorts to cut per long video (default 3). */ shortsPerLong?: number }

export interface SceneVisual { kind: 'video' | 'image'; path: string; asset: MediaAsset }
interface TimedScene { /** Phone screen to draw while the steps are said (phone-secrets channel). */ ui?: PhoneUi; n: number; start: number; duration: number; audioPath: string; voiceover: string; onScreenText: string; visual?: SceneVisual; shots?: Shot[]; /** Measured time of every script word (relative to the scene start), when aligned. */ words?: WordTime[]; /** Share of the script words heard in the audio. */ coverage?: number }
/** One background segment of the timeline (a shot, or a whole scene when it has no shots). */
interface Segment { n: number; duration: number; visual?: SceneVisual }

export interface RenderedShort { /** Drawn motion graphics or stock footage (the analyst compares them). */ look?: 'motion' | 'stock'; path: string; durationSec: number; scenes: number[]; title: string; /** What was on screen when (for the analyst: where viewers left and what was showing). */ shotLog?: { start: number; duration: number; said: string; showing: string }[]; /** Set when the frame audit found an immodest shot: never published. */ heldReason?: string }

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
    // Vertical: the code/feature sits in a solid box near the top for the whole Short (readable on any footage).
    { name: 'Title', font: FONT, size: Math.round(base * (vertical ? 0.075 : 0.09)), color: vertical ? '#FFD400' : '#FFFFFF', outline: vertical ? '#111111' : '#000000', outlineWidth: vertical ? Math.round(base * 0.022) : Math.max(2, Math.round(base * 0.005)), alignment: vertical ? 8 : 5, marginV: Math.round(o.height * (vertical ? 0.14 : 0.08)), bold: true, boxed: vertical },
    { name: 'Accent', font: FONT, size: Math.round(base * 0.05), color: o.accent, outline: '#000000', outlineWidth: 2, alignment: 8, marginV: Math.round(o.height * 0.06), bold: true },
    // Vertical captions sit in the lower part so a drawn phone screen (middle) never covers them.
    { name: 'Sub', font: FONT, size: Math.round(base * (vertical ? 0.075 : 0.062)), color: '#FFD400', secondary: '#FFFFFF', outline: '#000000', outlineWidth: Math.max(3, Math.round(base * 0.007)), shadow: 3, alignment: 2, marginV: Math.round(o.height * (vertical ? 0.07 : 0.08)), bold: true },
    { name: 'UI', font: FONT, size: Math.round(base * 0.04), color: '#FFFFFF', outline: '#000000', outlineWidth: 0, alignment: 7, marginV: 0 },
  ];
  const events: AssEvent[] = [];
  const subs: { start: number; end: number; text: string }[] = [];
  for (const s of scenes) {
    // Vertical Shorts keep the label (e.g. the code *#06#) on screen the whole time; long videos show it 5 s.
    if (s.onScreenText) events.push({ start: s.start + 0.2, end: s.start + (vertical ? s.duration - 0.1 : Math.min(s.duration - 0.1, 5)), style: 'Title', layer: 21, text: s.onScreenText, fadeMs: 300 });
    // Captions follow the measured time of each spoken word (forced alignment); proportional timing only as a fallback.
    const chunks = s.words?.length
      ? timedChunks(s.words, s.start, s.start + s.duration, vertical ? 4 : 7)
      : chunkSubtitles(s.voiceover, s.start, Math.max(0.1, s.duration), vertical ? 4 : 7);
    subs.push(...chunks);
    // Measured chunks: words light up as spoken (yellow fill) and each line pops in.
    events.push(...chunks.map((c) => ({ ...c, style: 'Sub', layer: 20, pop: 'karaokeCs' in c })));
    // Show what is being said: a phone screen typing the code / walking the settings path, in sync with the voice.
    if (vertical && s.ui && s.words?.length) {
      const ui = phoneUiEvents(s.ui, s.words, s.start, s.duration, o.width);
      if (ui) events.push(...ui);
    }
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

/**
 * Expands scenes into background segments (one per shot). A shot without footage never becomes an empty
 * coloured card in the middle of a video: it extends the previous shot (or the next one, at the start).
 */
export function segmentsOf(scenes: TimedScene[]): Segment[] {
  const raw = scenes.flatMap((s) => (s.shots?.length ? s.shots.map((sh) => ({ n: s.n, duration: sh.duration, visual: sh.visual })) : [{ n: s.n, duration: s.duration, visual: s.visual }]));
  if (!raw.some((x) => x.visual)) return raw;
  const out: Segment[] = [];
  let carry = 0;
  for (const seg of raw) {
    if (seg.visual) { out.push({ ...seg, duration: seg.duration + carry }); carry = 0; }
    else if (out.length) out.at(-1)!.duration += seg.duration;
    else carry += seg.duration;
  }
  return out;
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
    const queries = await queriesForSentences(this.ctx, perScene.flat(), fallbacks, videoId, this.ctx.repos.videos.get(videoId)?.title ?? '');
    // The real subject of each scene (pack: its own topic; long video: the main researched subject).
    const topics = this.ctx.repos.artifacts.latest<{ topics?: { subject: string; kind?: string }[] }>(videoId, 'calendar_entry')?.data.topics;
    const mainSubject = this.ctx.repos.artifacts.latest<{ queries?: string[] }>(videoId, 'research')?.data.queries?.[0];
    const withSubject = (q: string, subject: string | undefined, j: number) => {
      if (!subject) return q;
      const parts = queryParts(q);
      const entity = parts[0]?.startsWith('wm:') ? [parts.shift()!] : [];
      const real = `wm:${subject.replace(/\s*\(.*?\)/g, "").trim()}`;
      // Real photos of the company/product on every other sentence first, otherwise right after the clip query.
      const ordered = j % 2 === 0 ? [...entity, real, ...parts] : [...entity, parts[0]!, real, ...parts.slice(1)];
      return [...new Set(ordered.filter(Boolean))].join(' || ');
    };
    let k = 0;
    const lib = loadPhoneLibrary(this.ctx.config.rootDir);
    const perSceneFallback: string[][] = [];
    for (const [i, s] of scenes.entries()) {
      // Real photos only for real companies/people; an idea is shown through everyday footage instead.
      const subject = topics ? (topics[i]?.kind === 'story' ? topics[i]!.subject : undefined) : mainSubject;
      // Measured start of each sentence (from the aligned words), so the cut lands exactly when it is said.
      let wi = 0;
      const starts = perScene[i]!.map((text) => { const at = s.words?.[Math.min(wi, (s.words?.length ?? 1) - 1)]?.start; wi += scriptWords(text).length; return at; });
      // Phone secrets: this secret's own visuals are candidates for EVERY sentence, so what is shown is about
      // what is said (vision picks the closest); generic phone clips are only the very last resort.
      const own = lib?.secrets.find((x) => x.id === topics?.[i]?.subject)?.footage ?? [];
      const sentences = perScene[i]!.map((text, j) => ({ text, query: [withSubject(queries[k++]!, subject, j), own[j % Math.max(1, own.length)]].filter(Boolean).join(' || '), start: s.words?.length ? starts[j] : undefined }));
      s.shots = layoutShots(sentences.length ? sentences : [{ text: s.voiceover, query: fallbacks[0] ?? 'documentary' }], s.duration, learnedMaxShot(this.ctx));
      perSceneFallback.push([...own, ...this.ctx.config.channel.fallbackFootage]);
    }
    for (const [i, s] of scenes.entries()) {
      await fetchShotVisuals(this.ctx, s.shots ?? [], { targetWidth: size === 'full' ? 1280 : 960, orientation: 'landscape', cacheDir: resolve(this.ctx.config.rootDir, 'data/stock-cache'), used, notes, videoId, fallbackQueries: perSceneFallback[i] });
    }
    for (const s of scenes) s.visual = s.shots?.find((x) => x.visual)?.visual;
  }

  /** Frames every 2 s of a rendered video → vision modesty audit. Returns the reason if any frame fails. */
  private async modestyAudit(video: string, dir: string, tag: string, videoId: string): Promise<{ reason: string; frames: number[]; raw?: number[] } | undefined> {
    const fdir = resolve(dir, `audit-${tag}`);
    mkdirSync(fdir, { recursive: true });
    try {
      await ffmpeg(['-i', video, '-vf', 'fps=1/2,scale=360:-1', '-q:v', '5', resolve(fdir, 'f-%03d.jpg')]);
      const { readdirSync, readFileSync } = await import('node:fs');
      const frames = readdirSync(fdir).filter((f) => f.endsWith('.jpg')).sort().map((f) => readFileSync(resolve(fdir, f)));
      return await auditFrames(this.ctx, frames, videoId);
    } catch { return undefined; } finally { rmSync(fdir, { recursive: true, force: true }); }
  }

  private async editReview(video: string, dir: string, tag: string, said: { at: number; text: string }[], videoId: string) {
    const fdir = resolve(dir, `review-${tag}`);
    mkdirSync(fdir, { recursive: true });
    try {
      await ffmpeg(['-i', video, '-vf', 'fps=1/2,scale=360:-1', '-q:v', '5', resolve(fdir, 'f-%03d.jpg')]);
      const { readdirSync, readFileSync } = await import('node:fs');
      const frames = readdirSync(fdir).filter((f) => f.endsWith('.jpg')).sort().map((f) => readFileSync(resolve(fdir, f)));
      return await critiqueEdit(this.ctx, frames, said, videoId);
    } catch { return undefined; } finally { rmSync(fdir, { recursive: true, force: true }); }
  }

  /** motion vs stock for the next Short: keeps the recent mix at the learned share (STUDIO_LOOK overrides). */
  private pickLook(thisPack: RenderedShort[]): 'motion' | 'stock' {
    const forced = process.env.STUDIO_LOOK;
    if (forced === 'motion' || forced === 'stock') return forced === 'motion' && motionAvailable(this.ctx.config.rootDir) ? 'motion' : 'stock';
    if (this.ctx.providers.llm.name.startsWith('mock') || !motionAvailable(this.ctx.config.rootDir)) return 'stock';
    // Every Short is motion graphics (stock only as the fallback when drawing fails).
    void thisPack;
    return motionShare(this.ctx) > 0 ? 'motion' : 'stock';
  }

  /**
   * Plans, draws and reviews one motion Short. A Short the editing critic scores low (hook or match < 7) is
   * re-planned once with the critic's own notes and the better of the two kept. Returns its shot log, or
   * undefined (→ stock footage) if anything fails.
   */
  private async motionShort(o: { videoId: string; dir: string; n: number; audio: string; path: string; d: number; title: string; narration: string; words: WordTime[]; entry?: PhoneSecret; notes: string[]; retried?: boolean; retryNote?: string }): Promise<{ start: number; duration: number; said: string; showing: string }[] | undefined> {
    const root = this.ctx.config.rootDir;
    const input = { narration: o.narration, words: o.words, duration: o.d, title: o.title, entry: o.entry, brand: this.ctx.config.channel.channelName || 'سر الموبايل', endCard: 'تابع القناة لسر جديد كل يوم' };
    const said = (p: MotionPlan) => p.captions.map((c) => ({ at: c.a, text: c.text }));
    const score = (r?: { hook: number; visualMatch: number; pacing: number; captions: number }) => (r ? r.hook * 2 + r.visualMatch * 2 + r.pacing + r.captions : -1);
    try {
      let plan = await planMotion(this.ctx, input, o.videoId, o.retryNote);
      try { await renderMotion(root, plan, o.audio, o.path); } catch (e) {
        // Layout guard (text on top of text): re-plan once with shorter headlines; a second failure → stock.
        const msg = String((e as Error).message).match(/LAYOUT_OVERLAP[^\n]*/)?.[0];
        if (!msg) throw e;
        o.notes.push(`Short ${o.n}: layout guard stopped the render (${msg.slice(0, 140)}) — re-planned`);
        plan = await planMotion(this.ctx, input, o.videoId, `TEXTS OVERLAPPED in the previous attempt (${msg}). Use shorter headlines (≤ 4 words) and fewer texts on screen.`, false);
        await renderMotion(root, plan, o.audio, o.path);
      }
      let review = await this.editReview(o.path, o.dir, `motion-${o.n}`, said(plan), o.videoId);
      if (review && (review.hook < 7 || review.visualMatch < 7) && review.notes) {
        const plan2 = await planMotion(this.ctx, input, o.videoId, review.notes);
        const alt = o.path.replace(/\.mp4$/, '-b.mp4');
        const drawn = await renderMotion(root, plan2, o.audio, alt).then(() => true, () => false);
        const review2 = drawn ? await this.editReview(alt, o.dir, `motion-${o.n}-b`, said(plan2), o.videoId) : undefined;
        if (score(review2) > score(review)) { renameSync(alt, o.path); plan = plan2; review = review2; o.notes.push(`Short ${o.n}: motion re-planned after the critic's notes (${review?.hook}/10 hook)`); } else rmSync(alt, { force: true });
      }
      if (review) this.ctx.repos.artifacts.save({ videoId: o.videoId, kind: 'edit_review', agent: 'editing-critic', data: { n: o.n, look: 'motion', variants: plan.style.variants, ...review } });
      this.ctx.repos.artifacts.save({ videoId: o.videoId, kind: 'motion_plan', agent: 'motion-director', data: { n: o.n, plan } });
      o.notes.push(`Short ${o.n}: motion graphics (${plan.scenes.map((x) => x.type).join(' → ')})`);
      o.notes.push(`Short ${o.n}: design genes ${JSON.stringify(plan.style.variants)}`);
      return plan.scenes.map((x) => ({ start: x.start, duration: Number((x.end - x.start).toFixed(1)), said: plan.captions.filter((c) => c.a >= x.start && c.a < x.end).map((c) => c.text).join(' ').slice(0, 120), showing: `motion ${x.type} ${JSON.stringify(plan.style.variants ?? {}).replace(/"/g, '')}: ${x.headline.text}`.slice(0, 200) }));
    } catch (e) {
      const msg = String((e as Error).message).slice(0, 200);
      // Second full attempt (fresh plan, told what went wrong) before falling back to stock footage.
      if (!o.retried) {
        o.notes.push(`Short ${o.n}: motion graphics failed once (${msg.slice(0, 120)}) — trying again`);
        return this.motionShort({ ...o, retried: true, retryNote: `The previous attempt failed: ${msg}. Keep the plan simpler (fewer, shorter texts; standard scene types).` });
      }
      o.notes.push(`Short ${o.n}: motion graphics failed (${msg.slice(0, 160)}) — stock footage used`);
      // Into the error memory: a recurring drawing failure is studied and fixed, never silently repeated.
      this.ctx.repos.artifacts.save({ videoId: o.videoId, kind: 'motion_failure', agent: 'motion-director', data: { n: o.n, error: msg } });
      return undefined;
    }
  }

  private async renderPack(o: { videoId: string; dir: string; timed: TimedScene[]; t: number; size: RenderSize; palette: string[]; preset: string; notes: string[]; tts: TTSProvider; voiceName: string; th: ThumbnailOutput }): Promise<RenderOutput> {
    const bp = this.ctx.repos.artifacts.latest<Blueprint>(o.videoId, 'blueprint')!.data;
    const script = this.ctx.repos.artifacts.latest<Script>(o.videoId, 'script')!.data;
    await this.planShots(o.videoId, o.timed, bp, o.size, o.notes, new Set());
    const shots = o.timed.flatMap((s) => s.shots ?? []);
    const shorts: RenderedShort[] = [];
    const packTopics = this.ctx.repos.artifacts.latest<{ topics?: { title: string; subject?: string }[] }>(o.videoId, 'calendar_entry')?.data.topics;
    const lib = loadPhoneLibrary(this.ctx.config.rootDir);
    // Phone secrets: the screen drawing and the on-screen label always come from the reviewed library entry.
    o.timed.forEach((s, i) => { const e = lib?.secrets.find((x) => x.id === packTopics?.[i]?.subject); if (e) { s.ui = e.ui; s.onScreenText = e.onScreen; } });
    // Clips already used anywhere in the pack + clips that failed the modesty audit are never picked again.
    const banned = new Set<string>(o.timed.flatMap((x) => (x.shots ?? []).map((sh) => sh.visual?.asset.id).filter((id): id is string => Boolean(id))));
    for (const [i, s] of o.timed.entries()) {
      // A Short slightly over the limit is sped up a little (≤ 12%, still natural) instead of losing its ending.
      const tempo = s.duration > SHORT_MAX_SEC + 1 ? Math.min(1.12, s.duration / SHORT_MAX_SEC) : 1;
      const full = s.duration / tempo;
      const d = Math.min(full, SHORT_MAX_SEC + 1);
      if (tempo > 1) o.notes.push(`Scene ${s.n} is ${s.duration.toFixed(1)}s — narration sped up ×${tempo.toFixed(2)} to fit a Short.`);
      if (full > SHORT_MAX_SEC + 1) o.notes.push(`Scene ${s.n} is ${Math.round(s.duration)}s — trimmed to ${SHORT_MAX_SEC + 1}s`);
      const audio = resolve(o.dir, `short-${s.n}.m4a`);
      await ffmpeg(['-nostdin', '-i', s.audioPath, '-af', `${tempo > 1 ? `atempo=${tempo.toFixed(4)},` : ''}atrim=duration=${d.toFixed(3)},loudnorm=I=-14:TP=-1.5:LRA=11`, '-ar', '48000', '-c:a', 'aac', '-b:a', '160k', audio]);
      const path = resolve(o.dir, `short-${s.n}.mp4`);
      const scaled: TimedScene = {
        ...s, start: 0, duration: d,
        words: s.words?.map((w) => ({ ...w, start: w.start / tempo, end: w.end / tempo })),
        shots: trimShots(s.shots?.map((x) => ({ ...x, start: x.start / tempo, duration: x.duration / tempo })), d),
      };
      const sc = script.scenes.find((x) => x.n === s.n);
      const title = packTopics?.[i]?.title || sc?.curiosityGap || sc?.onScreenText || script.mainTitle;
      // Motion graphics (drawn, timed to the words) for a share of the Shorts; stock footage for the rest or on failure.
      if (this.pickLook(shorts) === 'motion' && (scaled.words?.length ?? 0) > 5) {
        const done = await this.motionShort({ videoId: o.videoId, dir: o.dir, n: s.n, audio, path, d, title, narration: s.voiceover, words: scaled.words!, entry: lib?.secrets.find((x) => x.id === packTopics?.[i]?.subject), notes: o.notes });
        if (done) { shorts.push({ look: 'motion', shotLog: done, path, durationSec: Number(d.toFixed(2)), scenes: [s.n], title }); continue; }
      }
      await this.renderTimeline([scaled], audio, path, { ...dims(o.size, true), palette: o.palette, preset: o.preset, endCard: 'تابع القناة لسر جديد كل يوم', assPath: resolve(o.dir, `short-${s.n}.ass`) });
      // Final safety net: the finished Short is looked at frame by frame (every 2 s) for modesty. A failing shot
      // is banned, replaced by another modest clip and the Short re-rendered (up to 2 times) before giving up.
      let held: string | undefined;
      for (let attempt = 0; ; attempt++) {
        const audit = await this.modestyAudit(path, o.dir, `short-${s.n}`, o.videoId);
        if (!audit) { held = undefined; break; }
        // Only immodesty holds a Short back; raw footage (green screen…) is replaced but never blocks it.
        held = audit.frames.length ? audit.reason : undefined;
        const times = [...audit.frames, ...(audit.raw ?? [])].map((f) => (f - 1) * 2);
        const badShots = (scaled.shots ?? []).filter((x) => x.visual && times.some((t) => t >= x.start - 0.5 && t <= x.start + x.duration + 0.5));
        if (attempt >= 2 || !badShots.length) break;
        o.notes.push(`Short ${s.n}: replaced ${badShots.length} shot(s) that failed the frame audit (${audit.reason.slice(0, 120)})`);
        for (const b of badShots) { banned.add(b.visual!.asset.id); b.visual = undefined; }
        await fetchShotVisuals(this.ctx, badShots, { targetWidth: o.size === 'full' ? 1280 : 960, orientation: 'landscape', cacheDir: resolve(this.ctx.config.rootDir, 'data/stock-cache'), used: banned, notes: o.notes, videoId: o.videoId, fallbackQueries: [...(lib?.secrets.find((x) => x.id === packTopics?.[i]?.subject)?.footage ?? []), ...this.ctx.config.channel.fallbackFootage] });
        await this.renderTimeline([scaled], audio, path, { ...dims(o.size, true), palette: o.palette, preset: o.preset, endCard: 'تابع القناة لسر جديد كل يوم', assPath: resolve(o.dir, `short-${s.n}.ass`) });
      }
      if (held) o.notes.push(`Short ${s.n} held back (modesty): ${held}`);
      // Editing critic: shots that don't show what is said are replaced once; the scores feed the analyst.
      if (!held) {
        const said = (scaled.shots ?? []).map((x) => ({ at: Number(x.start.toFixed(1)), text: x.text.slice(0, 100) }));
        let review = await this.editReview(path, o.dir, `short-${s.n}`, said, o.videoId);
        const bad = (scaled.shots ?? []).filter((x) => x.visual && (review?.mismatchAt ?? []).some((t) => t >= x.start - 0.5 && t <= x.start + x.duration + 0.5));
        if (review && bad.length && bad.length <= 3) {
          o.notes.push(`Short ${s.n}: editing critic replaced ${bad.length} shot(s) that didn't show what is said`);
          for (const b of bad) { banned.add(b.visual!.asset.id); b.visual = undefined; }
          await fetchShotVisuals(this.ctx, bad, { targetWidth: o.size === 'full' ? 1280 : 960, orientation: 'landscape', cacheDir: resolve(this.ctx.config.rootDir, 'data/stock-cache'), used: banned, notes: o.notes, videoId: o.videoId, fallbackQueries: [...(lib?.secrets.find((x) => x.id === packTopics?.[i]?.subject)?.footage ?? []), ...this.ctx.config.channel.fallbackFootage] });
          await this.renderTimeline([scaled], audio, path, { ...dims(o.size, true), palette: o.palette, preset: o.preset, endCard: 'تابع القناة لسر جديد كل يوم', assPath: resolve(o.dir, `short-${s.n}.ass`) });
          review = (await this.editReview(path, o.dir, `short-${s.n}-b`, said, o.videoId)) ?? review;
        }
        if (review) this.ctx.repos.artifacts.save({ videoId: o.videoId, kind: 'edit_review', agent: 'editing-critic', data: { n: s.n, look: 'stock', ...review } });
      }
      const shotLog = (scaled.shots ?? []).map((x) => ({ start: Number(x.start.toFixed(1)), duration: Number(x.duration.toFixed(1)), said: x.text.slice(0, 120), showing: (x.visual ? `${x.visual.asset.kind ?? 'clip'}: ${(x.visual.asset.tags ?? []).slice(0, 6).join(' ') || x.query.split('||')[0]!.trim()}` : 'drawn phone screen / text card').slice(0, 120) }));
      shorts.push({ look: 'stock', shotLog, path, durationSec: Number(d.toFixed(2)), scenes: [s.n], title, ...(held ? { heldReason: held } : {}) });
    }
    const first = shorts[0]!;
    const audio = await volumeStats(resolve(o.dir, `short-${o.timed[0]!.n}.m4a`));
    const silent = !Number.isFinite(audio.meanDb) || audio.meanDb < -50;
    const assets: MediaAsset[] = [
      { id: 'voice', kind: 'voice', path: o.dir, license: 'generated-owned', source: o.tts.name, aiGenerated: true },
      ...uniqueAssets(shots),
    ];
    const withStock = shots.filter((x) => x.visual).length;
    const openingMissing = o.timed.some((s) => !s.shots?.[0]?.visual);
    const anyTrimmed = o.timed.some((s) => s.duration / 1.12 > SHORT_MAX_SEC + 1);
    const lowCoverage = o.timed.filter((s) => s.coverage !== undefined && s.coverage < 0.7);
    if (lowCoverage.length) o.notes.push(`Narration does not match the script in Short(s) ${lowCoverage.map((s) => s.n).join(', ')} — publish blocked.`);
    if (o.timed.every((s) => s.words?.length)) o.notes.push(`Captions, cuts and shots timed from the measured words (${o.timed.map((s) => `${Math.round((s.coverage ?? 0) * 100)}%`).join(' / ')} of script words heard).`);
    if (openingMissing) o.notes.push('At least one Short opens without a matching visual.');
    if (anyTrimmed) o.notes.push('At least one Short was trimmed, so its captions may not cover the full narration.');
    return {
      videoPath: first.path, thumbnailPath: '', captionsPath: '',
      durationSec: first.durationSec, size: dims(o.size, true),
      scenes: o.timed.map(({ n, start, duration, audioPath, visual }) => ({ n, start: Number(start.toFixed(2)), duration: Number(duration.toFixed(2)), audioPath, visual: visual ? `${visual.kind}:${visual.asset.id}` : 'text-card' })),
      shorts, packOnly: true,
      voice: { provider: o.tts.name, voice: o.voiceName, synthetic: true },
      visualMode: withStock === 0 ? 'text-cards' : withStock === shots.length ? 'stock' : 'mixed',
      assets,
      measurements: { audio, audioScore: silent ? 0 : lowCoverage.length ? 40 : 85, visualScore: openingMissing ? Math.min(visualScoreFor(shots), 70) : visualScoreFor(shots), subtitleAccuracy: anyTrimmed ? 0 : 100, avSyncDiffSec: 0, notes: o.notes },
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
    const voicesUsed: string[] = [];
    const root = this.ctx.config.rootDir;
    const voiceAll = async (provider: TTSProvider) => {
      const out: TimedScene[] = [];
      let start = 0;
      const real = !provider.name.startsWith('mock');
      // Gemini's free tier allows ~10 voice requests a day: voice scenes in a few batches, then split at the
      // exact word where each scene ends (measured by listening to the audio, see align.ts).
      const pre = new Map<number, TTSResult & { words?: WordTime[]; coverage?: number }>();
      if (provider.name.startsWith('gemini')) {
        for (const [bi, group] of batchScenes(bp.scenes).entries()) {
          const dirs = group.map((g) => script.scenes.find((x) => x.n === g.n)?.delivery);
          const r = await provider.synthesize(group.map((g) => g.voiceover).join('\n\n'), resolve(dir, `batch-${bi + 1}.aiff`), { tone: dirs[0]?.tone, pace: dirs[0]?.pace });
          voicesUsed.push(r.voice);
          const parts = group.map((g) => resolve(dir, `scene-${g.n}.batch.wav`));
          const split = await splitBatch(r.audioPath, group.map((g) => g.voiceover), parts, { rootDir: root });
          if (split.trimmedLeadIn > 0.8) notes.push(`Batch ${bi + 1}: removed ${split.trimmedLeadIn.toFixed(1)}s of speech that was not in the script (voice read its notes aloud).`);
          if (!split.aligned) notes.push(`Batch ${bi + 1}: speech alignment unavailable (${lastAlignError || 'unknown'}) — scene cuts and captions use estimated timing.`);
          group.forEach((g, i) => pre.set(g.n, { audioPath: parts[i]!, durationSec: 0, characters: g.voiceover.length, voice: r.voice, words: split.words?.[i], coverage: split.coverage?.[i] }));
        }
      }
      for (const s of bp.scenes) {
        const sc = script.scenes.find((x) => x.n === s.n);
        let r: TTSResult & { words?: WordTime[]; coverage?: number } = pre.get(s.n) ?? await provider.synthesize(s.voiceover, resolve(dir, `scene-${s.n}.aiff`), sc?.delivery);
        /** Aligns a single-scene recording (trims speech before the first script word). */
        const alignOne = async (x: TTSResult, tag: string) => {
          if (!real || !existsSync(x.audioPath)) return x;
          const p = resolve(dir, `scene-${s.n}.${tag}.aligned.wav`);
          const sp = await splitBatch(x.audioPath, [s.voiceover], [p], { rootDir: root });
          return sp.aligned ? { ...x, audioPath: p, words: sp.words?.[0], coverage: sp.coverage?.[0] } : x;
        };
        if (!pre.has(s.n)) r = await alignOne(r, 'take1');
        // Stage gate: a scene whose audio is silent, cut off, stretched — or does not say the script — is
        // re-recorded on its own right away (up to 2x).
        for (let attempt = 0; attempt < 2 && existsSync(r.audioPath) && real; attempt++) {
          const problem = (await sceneAudioProblem(r.audioPath, s.voiceover, this.ctx.config.thresholds.script.arabicWordsPerMinute))
            ?? (r.coverage !== undefined && r.coverage < 0.7 ? `narration does not match the script (${Math.round(r.coverage * 100)}% of words heard)` : undefined);
          if (!problem) break;
          this.ctx.logger.child('renderer').warn('re-recording scene audio', { videoId, scene: s.n, problem });
          notes.push(`Scene ${s.n} re-recorded: ${problem}.`);
          r = await alignOne(await provider.synthesize(s.voiceover, resolve(dir, `scene-${s.n}-retry${attempt + 1}.aiff`), sc?.delivery), `retry${attempt + 1}`);
        }
        voiceName = r.voice;
        voicesUsed.push(r.voice);
        const wav = resolve(dir, `scene-${s.n}.wav`);
        if (existsSync(r.audioPath)) {
          // Dramatic silence after big lines; a normal breath otherwise.
          await ffmpeg(['-i', r.audioPath, '-af', `apad=pad_dur=${sc?.delivery?.pauseAfter ? 1.1 : 0.45}`, '-ar', '48000', '-ac', '1', wav]);
        } else {
          // Mock TTS produces no file: use silence of the estimated length so the pipeline is still exercised.
          await ffmpeg(['-f', 'lavfi', '-i', `anullsrc=r=48000:cl=mono`, '-t', String(Math.max(1, r.durationSec) + 0.45), wav]);
        }
        const duration = await probeDuration(wav);
        out.push({ n: s.n, start, duration, audioPath: wav, voiceover: s.voiceover, onScreenText: s.onScreenText, words: r.words, coverage: r.coverage });
        start += duration;
        this.ctx.cost.record({ provider: provider.name, operation: 'tts', videoId, units: r.characters, unit: 'characters', usd: 0 });
      }
      return { out, total: start };
    };
    try {
      let v = await voiceAll(tts);
      // The voice model changed part-way (a daily quota ran out): re-voice everything with one model.
      const models = new Set(voicesUsed);
      if (models.size > 1) {
        notes.push(`Voice model switched mid-video (${[...models].join(' → ')}) — re-voiced the whole video with one model.`);
        voicesUsed.length = 0;
        v = await voiceAll(tts);
      }
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
    const mix = await mixSoundtrackSafe({ voice, durationSec: t, cues: cuesFor(beats), musicPath, dir, out: soundtrack });
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
      await ffmpeg(['-nostdin', '-i', wav, '-af', `atrim=duration=${d},loudnorm=I=-14:TP=-1.5:LRA=11`, '-ar', '48000', '-c:a', 'aac', '-b:a', '160k', saudio]);
      const sentences = splitSentences(text);
      const qs = await queriesForSentences(this.ctx, sentences, bp.scenes.find((x) => x.n === scene.n)?.stockQuery || 'documentary', videoId, title);
      const shortShots = layoutShots(sentences.map((t2, i) => ({ text: t2, query: qs[i]! })), d);
      await fetchShotVisuals(this.ctx, shortShots, { targetWidth: size === 'full' ? 1280 : 960, orientation: 'landscape', cacheDir: resolve(this.ctx.config.rootDir, 'data/stock-cache'), used: usedClips, notes, videoId, fallbackQueries: this.ctx.config.channel.fallbackFootage });
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
    const offScript = timed.filter((s) => s.coverage !== undefined && s.coverage < 0.7);
    if (offScript.length) notes.push(`Narration does not match the script in scene(s) ${offScript.map((s) => s.n).join(', ')} — publish blocked.`);
    if (timed.every((s) => s.words?.length)) notes.push(`Captions, cuts and shots timed from the measured words (avg ${Math.round((timed.reduce((a, s) => a + (s.coverage ?? 0), 0) / timed.length) * 100)}% of script words heard).`);
    const audioScore = silent ? 0 : offScript.length ? 40 : audio.maxDb > -0.5 ? 70 : audio.meanDb >= -30 && audio.meanDb <= -10 ? 85 : 70;
    if (!silent && tts.name === 'macos-say') notes.push(`Synthetic voice "${voiceName}" (macOS): clear but robotic.`);
    if (!silent && tts.name === 'gemini-tts') notes.push(`Natural AI voice "${voiceName}" (Gemini) — YouTube synthetic-content disclosure will be enabled to be safe.`);
    const subWords = subs.map((s) => s.text).join(' ').split(/\s+/).filter(Boolean);
    const voWords = timed.map((s) => s.voiceover).join(' ').split(/\s+/).filter(Boolean);
    const normalizeCaptionWords = (xs: string[]) => xs.join(' ').replace(/[ًٌٍَُِّْـ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
    const expectedCaptionWords = normalizeCaptionWords(voWords);
    const actualCaptionWords = normalizeCaptionWords(subWords);
    const captionMatches = expectedCaptionWords.length === actualCaptionWords.length && expectedCaptionWords.every((w, i) => w === actualCaptionWords[i]);
    const subtitleAccuracy = captionMatches ? 100 : Math.round((actualCaptionWords.filter((w, i) => w === expectedCaptionWords[i]).length / Math.max(1, expectedCaptionWords.length)) * 100);
    if (!captionMatches) notes.push('Caption text differs from the narrated script; render is not publish-ready.');
    const avSyncDiffSec = Number(Math.abs(durationSec - t).toFixed(2));
    if (avSyncDiffSec > 1) notes.push(`Video/audio length differ by ${avSyncDiffSec}s`);
    const shotsAll = [...allShots(), ...extraShots];
    const firstShotMatched = Boolean(allShots()[0]?.visual);
    const rawVisualScore = statSync(videoPath).size > 10_000 ? visualScoreFor(allShots()) : 0;
    const visualScore = firstShotMatched ? rawVisualScore : Math.min(rawVisualScore, 70);
    if (!firstShotMatched) notes.push('Opening visual has no matched asset; publish blocked until the hook gets a concrete visual or deliberate graphic.');
    const withStock = allShots().filter((x) => x.visual).length;
    notes.push(`${allShots().length} shots (one per sentence, ~${(t / Math.max(1, allShots().length)).toFixed(1)}s each); ${withStock} with stock footage.`);
    if (withStock) notes.push('Stock footage used — check none shows identifiable people/brands in a misleading way.');

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
