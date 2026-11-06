/**
 * Gemini TTS free tier allows only ~10 requests a day, so scenes are voiced in a few batched requests
 * (one continuous, consistent performance) and the audio is split back per scene at the natural
 * pauses closest to each scene boundary.
 */
import { ffmpeg, probeDuration } from './ffmpeg.ts';

const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;

/**
 * Contiguous groups of scenes, balanced by word count, ~`maxWords` words each (≥ 1 scene per group).
 * 450 words ≈ 3.5 min of audio — safely inside one TTS response; a cut-off tail is caught by the audio gate.
 */
export function batchScenes<T extends { voiceover: string }>(scenes: T[], maxWords = 450): T[][] {
  const total = scenes.reduce((a, s) => a + words(s.voiceover), 0);
  const groups = Math.max(1, Math.ceil(total / maxWords));
  const target = total / groups;
  const out: T[][] = [[]];
  let acc = 0;
  for (const s of scenes) {
    const w = words(s.voiceover);
    const cur = out.at(-1)!;
    // Start a new group when adding this scene would overshoot the target more than staying under it.
    if (cur.length && out.length < groups && acc + w / 2 > target * out.length) out.push([]);
    out.at(-1)!.push(s);
    acc += w;
  }
  return out;
}

/** Silence midpoints (seconds) found by ffmpeg's silencedetect. */
export async function silences(path: string, minSec = 0.25): Promise<number[]> {
  const err = await ffmpeg(['-i', path, '-af', `silencedetect=noise=-35dB:d=${minSec}`, '-f', 'null', '-']);
  const starts = [...err.matchAll(/silence_start:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...err.matchAll(/silence_end:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  return starts.map((s, i) => (ends[i] !== undefined ? (s + ends[i]!) / 2 : s));
}

/** Cut points between texts: proportional to word count, snapped to the nearest pause within ±20% of a scene. */
export function cutPoints(texts: string[], duration: number, pauses: number[]): number[] {
  const w = texts.map(words);
  const total = w.reduce((a, b) => a + b, 0) || 1;
  const cuts: number[] = [];
  let acc = 0;
  for (let i = 0; i < texts.length - 1; i++) {
    acc += w[i]!;
    const ideal = (acc / total) * duration;
    const tol = Math.max(1.5, (w[i]! / total) * duration * 0.2);
    const prev = cuts.at(-1) ?? 0;
    const near = pauses.filter((p) => p > prev + 0.5 && Math.abs(p - ideal) <= tol).sort((a, b) => Math.abs(a - ideal) - Math.abs(b - ideal))[0];
    cuts.push(near ?? ideal);
  }
  return cuts;
}

/** Splits one narrated batch into per-scene files. */
export async function splitBatch(path: string, texts: string[], outPaths: string[]): Promise<void> {
  if (texts.length === 1) {
    await ffmpeg(['-i', path, '-c', 'copy', outPaths[0]!]);
    return;
  }
  const duration = await probeDuration(path);
  const cuts = cutPoints(texts, duration, await silences(path));
  const bounds = [0, ...cuts, duration];
  for (let i = 0; i < texts.length; i++) {
    await ffmpeg(['-i', path, '-af', `atrim=start=${bounds[i]!.toFixed(3)}:end=${bounds[i + 1]!.toFixed(3)},asetpts=PTS-STARTPTS`, outPaths[i]!]);
  }
}
