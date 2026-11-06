/**
 * Sound design (free, local): synthesized transition whooshes + reveal impacts, optional music bed from
 * the repo's `music/` folder (royalty-free tracks you are licensed to use), auto-ducked under the narration
 * (sidechain compression) and the final mix normalised for YouTube (-14 LUFS).
 */
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ffmpeg } from './ffmpeg.ts';

export interface SoundCue { at: number; kind: 'whoosh' | 'impact' }

/** Generates the SFX library once per render folder. */
export async function ensureSfx(dir: string) {
  const whoosh = resolve(dir, 'sfx-whoosh.wav');
  const impact = resolve(dir, 'sfx-impact.wav');
  if (!existsSync(whoosh)) await ffmpeg(['-f', 'lavfi', '-i', 'anoisesrc=d=0.8:c=pink:a=0.55:r=48000', '-af', 'highpass=f=350,lowpass=f=7000,afade=t=in:d=0.3,afade=t=out:st=0.35:d=0.45,volume=0.9', whoosh]);
  if (!existsSync(impact)) await ffmpeg(['-f', 'lavfi', '-i', 'sine=f=52:d=1.4:r=48000', '-f', 'lavfi', '-i', 'anoisesrc=d=0.25:c=brown:a=0.7:r=48000', '-filter_complex', '[0]afade=t=out:st=0.05:d=1.3,volume=1.6[b];[1]lowpass=f=900,afade=t=out:d=0.25[n];[b][n]amix=inputs=2:normalize=0,alimiter=limit=0.9', impact]);
  return { whoosh, impact };
}

/** Cues: a whoosh into every new scene, an impact on reveal beats. */
export function cuesFor(scenes: { start: number; beat?: string }[]): SoundCue[] {
  const cues: SoundCue[] = [];
  scenes.forEach((s, i) => {
    if (i > 0) cues.push({ at: Math.max(0, s.start - 0.3), kind: 'whoosh' });
    if (s.beat === 'reveal' || s.beat === 'hook') cues.push({ at: s.start + 0.05, kind: 'impact' });
  });
  return cues;
}

const MOODS: Record<string, string[]> = {
  suspense: ['suspense', 'dark', 'mystery', 'tension', 'cinematic'],
  inspiring: ['inspiring', 'uplifting', 'epic', 'hope'],
  calm: ['calm', 'ambient', 'soft', 'piano'],
};

/** Picks a track from music/ whose file name matches the mood (falls back to any track). */
export function pickMusic(musicDir: string, mood: string, seed = 0): string | undefined {
  if (!existsSync(musicDir)) return undefined;
  const files = readdirSync(musicDir).filter((f) => /\.(mp3|m4a|wav|ogg)$/i.test(f)).sort();
  if (!files.length) return undefined;
  const key = Object.entries(MOODS).find(([, words]) => words.some((w) => mood.toLowerCase().includes(w)))?.[0];
  const matching = key ? files.filter((f) => MOODS[key]!.some((w) => f.toLowerCase().includes(w))) : [];
  const pool = matching.length ? matching : files;
  return resolve(musicDir, pool[seed % pool.length]!);
}

/**
 * voice + (ducked music) + SFX → one AAC track at -14 LUFS.
 * Music sits ~-22 dB under the voice and dips further whenever the narrator speaks.
 */
export async function mixSoundtrack(o: { voice: string; durationSec: number; cues: SoundCue[]; musicPath?: string; dir: string; out: string }) {
  const sfx = await ensureSfx(o.dir);
  const inputs = ['-i', o.voice];
  const parts: string[] = ['[0:a]aformat=sample_rates=48000:channel_layouts=stereo,asplit=2[voice][key]'];
  const mixIn = ['[voice]'];
  let idx = 1;
  if (o.musicPath) {
    // The bed is prepared in its own short ffmpeg run (looped + trimmed to the exact length), so the main
    // graph only reads a finite file — looping inside the graph (aloop/-stream_loop) can stall it.
    const bed = resolve(o.dir, 'music-bed.wav');
    await ffmpeg(['-stream_loop', '-1', '-i', o.musicPath, '-t', o.durationSec.toFixed(2), '-af', `aformat=sample_rates=48000:channel_layouts=stereo,volume=0.22,afade=t=in:d=2,afade=t=out:st=${Math.max(0, o.durationSec - 3).toFixed(2)}:d=3`, '-ar', '48000', '-ac', '2', bed], { timeoutMs: 5 * 60_000 });
    inputs.push('-i', bed);
    parts.push(`[${idx}:a]anull[mus]`);
    // sidechaincompress never ends once its key (the voice) hits EOF: pad the key forever and trim the output.
    parts.push('[key]apad[keyp]');
    parts.push(`[mus][keyp]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=350,atrim=duration=${o.durationSec.toFixed(2)}[ducked]`);
    mixIn.push('[ducked]');
    idx++;
  } else {
    parts.push('[key]anullsink');
  }
  const wIdx = idx++, iIdx = idx++;
  inputs.push('-i', sfx.whoosh, '-i', sfx.impact);
  const w = o.cues.filter((c) => c.kind === 'whoosh');
  const im = o.cues.filter((c) => c.kind === 'impact');
  if (w.length) {
    parts.push(`[${wIdx}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=0.35,asplit=${w.length}${w.map((_, i) => `[w${i}]`).join('')}`);
    w.forEach((c, i) => parts.push(`[w${i}]adelay=${Math.round(c.at * 1000)}:all=1[wd${i}]`));
    mixIn.push(...w.map((_, i) => `[wd${i}]`));
  } else parts.push(`[${wIdx}:a]anullsink`);
  if (im.length) {
    parts.push(`[${iIdx}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=0.5,asplit=${im.length}${im.map((_, i) => `[i${i}]`).join('')}`);
    im.forEach((c, i) => parts.push(`[i${i}]adelay=${Math.round(c.at * 1000)}:all=1[id${i}]`));
    mixIn.push(...im.map((_, i) => `[id${i}]`));
  } else parts.push(`[${iIdx}:a]anullsink`);
  // Trim inside the graph (not with output -t): loudnorm keeps a 3 s look-ahead, and an output -t that
  // stops reading mid-buffer deadlocks the graph.
  parts.push(`${mixIn.join('')}amix=inputs=${mixIn.length}:normalize=0:duration=first,atrim=duration=${o.durationSec.toFixed(2)},loudnorm=I=-14:TP=-1.5:LRA=11[out]`);
  await ffmpeg(['-nostdin', ...inputs, '-filter_complex', parts.join(';'), '-map', '[out]', '-ar', '48000', '-c:a', 'aac', '-b:a', '192k', o.out], { timeoutMs: 15 * 60_000 });
  return { musicUsed: Boolean(o.musicPath), cues: o.cues.length };
}

/** Like mixSoundtrack, but a music problem never costs the video: it falls back to voice + SFX. */
export async function mixSoundtrackSafe(o: Parameters<typeof mixSoundtrack>[0]) {
  try {
    return await mixSoundtrack(o);
  } catch (err) {
    if (!o.musicPath) throw err;
    const r = await mixSoundtrack({ ...o, musicPath: undefined });
    return { ...r, musicError: (err as Error).message.slice(0, 160) };
  }
}
