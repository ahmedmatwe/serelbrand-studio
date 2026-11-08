/**
 * Forced alignment: WHEN is each word of the script actually spoken?
 *
 * Proportional timing (word count ÷ duration) drifts by seconds: the voice speeds up, slows down, breathes at
 * every "…" and numbers take far longer to say than to write. That drift is what made captions lag the voice,
 * shots change in the wrong place, and batched narration get cut mid-sentence (a Short that "starts from the
 * middle"). Here a free local speech recogniser (faster-whisper, scripts/align.py) listens to the real audio,
 * and its words are aligned to the exact script words, so every script word gets a measured start/end.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface RecWord { w: string; s: number; e: number }
export interface WordTime { w: string; start: number; end: number; matched: boolean }
export interface Alignment { words: WordTime[]; /** Share of script words heard in the audio (0–1). */ coverage: number; /** Speech heard before the first script word (e.g. an instruction read aloud). */ leadIn: number }

const DIGITS = '٠١٢٣٤٥٦٧٨٩';
/** Comparable form of an Arabic/Latin word: no diacritics/tatweel/punctuation, unified alef/ya/ta-marbuta. */
export function normWord(w: string): string {
  return w
    .replace(/[٠-٩]/g, (d) => String(DIGITS.indexOf(d)))
    .replace(/[\p{M}ـ]/gu, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Normalised similarity 0–1 (1 − Levenshtein / longest). */
export function similarity(a: string, b: string): number {
  if (a === b) return a ? 1 : 0;
  if (!a || !b) return 0;
  // Common Arabic prefixes ("و", "ف", "ب", "ال") often get split or merged by the recogniser.
  const strip = (x: string) => x.replace(/^(و|ف)?(ال|بال|لل|كال)?/, '');
  if (strip(a) && strip(a) === strip(b)) return 0.9;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[n]! / Math.max(m, n);
}

/** Splits text into the words captions show (punctuation kept on the word). */
export const scriptWords = (text: string) => text.trim().split(/\s+/).filter((w) => normWord(w).length > 0);

/**
 * Global alignment (Needleman–Wunsch) of script words to recognised words. Unmatched script words
 * (numbers read out in full, a word the recogniser missed) get times interpolated between their neighbours.
 */
export function alignWords(script: string[], rec: RecWord[], totalSec: number): Alignment {
  const n = script.length, m = rec.length;
  if (!n) return { words: [], coverage: 1, leadIn: 0 };
  const a = script.map(normWord), b = rec.map((r) => normWord(r.w));
  const GAP = -0.6;
  const W = m + 1;
  const score = new Float32Array((n + 1) * W);
  const move = new Uint8Array((n + 1) * W); // 1 diag, 2 up (script gap), 3 left (extra recognised word)
  for (let i = 1; i <= n; i++) { score[i * W] = i * GAP; move[i * W] = 2; }
  for (let j = 1; j <= m; j++) { score[j] = j * GAP; move[j] = 3; }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const sim = similarity(a[i - 1]!, b[j - 1]!);
      const d = score[(i - 1) * W + j - 1]! + (sim >= 0.5 ? 2 * sim : -1);
      const u = score[(i - 1) * W + j]! + GAP;
      const l = score[i * W + j - 1]! + GAP;
      const best = Math.max(d, u, l);
      score[i * W + j] = best;
      move[i * W + j] = best === d ? 1 : best === u ? 2 : 3;
    }
  }
  const match = new Array<number>(n).fill(-1);
  for (let i = n, j = m; i > 0 || j > 0;) {
    const mv = move[i * W + j];
    if (i > 0 && j > 0 && mv === 1) { if (similarity(a[i - 1]!, b[j - 1]!) >= 0.5) match[i - 1] = j - 1; i--; j--; }
    else if (i > 0 && (j === 0 || mv === 2)) i--;
    else j--;
  }
  const words: WordTime[] = script.map((w, i) => (match[i]! >= 0 ? { w, start: rec[match[i]!]!.s, end: rec[match[i]!]!.e, matched: true } : { w, start: NaN, end: NaN, matched: false }));
  // Interpolate unmatched runs between the surrounding matched words, by character length.
  for (let i = 0; i < n;) {
    if (words[i]!.matched) { i++; continue; }
    let k = i;
    while (k < n && !words[k]!.matched) k++;
    const from = i > 0 ? words[i - 1]!.end : 0;
    const to = k < n ? words[k]!.start : Math.max(from, totalSec);
    const len = words.slice(i, k).reduce((s, x) => s + Math.max(2, [...x.w].length), 0);
    let t = from;
    for (let x = i; x < k; x++) {
      const d = ((to - from) * Math.max(2, [...words[x]!.w].length)) / len;
      words[x]!.start = t; words[x]!.end = t + d; t += d;
    }
    i = k;
  }
  const matched = words.filter((w) => w.matched).length;
  const firstMatched = match.find((x) => x >= 0);
  const leadIn = firstMatched !== undefined && firstMatched > 0 ? rec[firstMatched]!.s - rec[0]!.s : 0;
  return { words, coverage: matched / n, leadIn: firstMatched !== undefined && firstMatched >= 3 ? leadIn : 0 };
}

/** Why the last recognition attempt failed (shown in the render notes, so a cloud failure is never silent). */
export let lastAlignError = '';

/** Runs the recogniser on a file. Undefined when it is not installed/disabled — callers fall back gracefully. */
export function transcribeWords(audioPath: string, rootDir: string, lang = 'ar'): Promise<RecWord[] | undefined> {
  if (process.env.ALIGN === 'off') { lastAlignError = 'ALIGN=off'; return Promise.resolve(undefined); }
  const script = resolve(rootDir, 'scripts/align.py');
  if (!existsSync(script)) { lastAlignError = `missing ${script}`; return Promise.resolve(undefined); }
  if (!existsSync(audioPath)) { lastAlignError = `missing audio ${audioPath}`; return Promise.resolve(undefined); }
  const py = process.env.WHISPER_PYTHON || 'python3';
  return new Promise((done) => {
    execFile(py, [script, audioPath, lang], { maxBuffer: 64 * 1024 * 1024, timeout: 20 * 60_000 }, (err, stdout, stderr) => {
      const tail = (x: string) => x.trim().split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 300);
      try {
        const out = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as { words?: RecWord[]; error?: string };
        if (out.words?.length) { lastAlignError = ''; return done(out.words); }
        lastAlignError = out.error ?? `no words recognised${stderr ? ` (${tail(stderr)})` : ''}`;
      } catch {
        lastAlignError = `${py} failed: ${err?.message.slice(0, 120) ?? ''} ${tail(stderr ?? '')}`.trim();
      }
      done(undefined);
    });
  });
}

/** Recognises + aligns one narration file against its exact text. */
export async function alignAudio(audioPath: string, text: string, totalSec: number, rootDir: string): Promise<Alignment | undefined> {
  const rec = await transcribeWords(audioPath, rootDir);
  return rec ? alignWords(scriptWords(text), rec, totalSec) : undefined;
}

/**
 * Cut points between consecutive texts of one batched narration, from the measured word times:
 * the middle of the gap between the last word of text i and the first word of text i+1
 * (snapped to a detected pause inside that gap when there is one).
 */
export function alignedCutPoints(texts: string[], words: WordTime[], pauses: number[] = []): number[] {
  const cuts: number[] = [];
  let k = 0;
  for (let i = 0; i < texts.length - 1; i++) {
    k += scriptWords(texts[i]!).length;
    const lastEnd = words[k - 1]?.end ?? 0;
    const nextStart = words[k]?.start ?? lastEnd;
    const inGap = pauses.filter((p) => p >= lastEnd - 0.05 && p <= nextStart + 0.05);
    cuts.push(inGap.length ? inGap.sort((x, y) => Math.abs(x - (lastEnd + nextStart) / 2) - Math.abs(y - (lastEnd + nextStart) / 2))[0]! : (lastEnd + Math.max(lastEnd, nextStart)) / 2);
  }
  return cuts;
}

/** Caption chunks timed by the spoken words (≤ maxWords, breaking after punctuation). */
export function timedChunks(words: WordTime[], offset: number, sceneEnd: number, maxWords: number): { start: number; end: number; text: string }[] {
  const groups: WordTime[][] = [];
  let cur: WordTime[] = [];
  for (const w of words) {
    cur.push(w);
    // Also break on a real pause (> 0.45 s) so a caption never hangs over silence.
    const next = words[words.indexOf(w) + 1];
    const pause = next ? next.start - w.end > 0.45 : false;
    if (cur.length >= maxWords || (/[.،,؟?!:؛…]$/.test(w.w) && cur.length >= 2) || (pause && cur.length >= 2)) { groups.push(cur); cur = []; }
  }
  if (cur.length) groups.push(cur);
  // No orphan 1–2 word captions flashing by: join them to the previous line when it did not end a sentence.
  for (let i = groups.length - 1; i > 0; i--) {
    const prev = groups[i - 1]!, g = groups[i]!;
    if (g.length <= 2 && !/[.؟?!؛…]$/.test(prev.at(-1)!.w) && prev.length + g.length <= maxWords + 2 && g[0]!.start - prev.at(-1)!.end < 0.45) {
      groups.splice(i - 1, 2, [...prev, ...g]);
    }
  }
  return groups.map((g, i) => {
    const start = offset + Math.max(0, g[0]!.start - 0.05);
    const nextStart = groups[i + 1] ? offset + groups[i + 1]![0]!.start - 0.05 : sceneEnd;
    const end = Math.min(nextStart, offset + g.at(-1)!.end + 0.35, sceneEnd);
    return { start, end: Math.max(end, Math.min(start + 0.3, nextStart)), text: g.map((x) => x.w).join(' ') };
  });
}
