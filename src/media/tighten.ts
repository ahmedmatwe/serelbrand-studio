/**
 * Continuous narration: the pauses between sentences are shortened to a natural breath (no dead air) — the voice
 * runs on, the viewer never waits. Returns a time map so every word / shot timing moves with the cut.
 */
import { ffmpeg } from './ffmpeg.ts';

export interface TightenResult { removed: [number, number][]; map: (t: number) => number; saved: number }

/** Silences ≥ minGap (s) below `db` are cut down to `keep` seconds (the first `keep` s of each pause stay). */
export function pausesToCut(silences: [number, number][], keep = 0.1, minGap = 0.2, total = Infinity): [number, number][] {
  return silences
    .filter(([a, b]) => b - a >= minGap && b < total - 0.05) // never cut the natural end of the Short
    .map(([a, b]): [number, number] => [a <= 0.01 ? 0 : a + keep, b - (a <= 0.01 ? 0.03 : 0)])
    .filter(([a, b]) => b - a > 0.02);
}

export function timeMap(removed: [number, number][]): (t: number) => number {
  return (t: number) => {
    let shift = 0;
    for (const [a, b] of removed) { if (t >= b) shift += b - a; else if (t > a) return Number((a - shift).toFixed(3)); }
    return Number((t - shift).toFixed(3));
  };
}

export async function tightenNarration(input: string, output: string, total: number, keep = 0.1): Promise<TightenResult> {
  const log = await ffmpeg(['-nostdin', '-i', input, '-af', 'silencedetect=n=-38dB:d=0.2', '-f', 'null', '-']);
  const starts = [...log.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...log.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  const silences = starts.map((a, i): [number, number] => [a, ends[i] ?? total]);
  const removed = pausesToCut(silences, keep, 0.2, total);
  if (!removed.length) { await ffmpeg(['-nostdin', '-i', input, '-c', 'copy', output]); return { removed, map: (t) => t, saved: 0 }; }
  const expr = removed.map(([a, b]) => `between(t,${a.toFixed(3)},${b.toFixed(3)})`).join('+');
  await ffmpeg(['-nostdin', '-i', input, '-af', `aselect='not(${expr})',asetpts=N/SR/TB`, output]);
  return { removed, map: timeMap(removed), saved: Number(removed.reduce((s, [a, b]) => s + b - a, 0).toFixed(2)) };
}
