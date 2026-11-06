/**
 * Shot planning: one visual per sentence (cut every ~2.5–5.5 s), so the footage follows what the narrator says.
 */
import { z } from 'zod';
import { countWords } from '../agents/base.ts';
import type { AgentContext } from '../agents/base.ts';
import type { MediaAsset } from '../providers/media.ts';

export interface ShotVisual { kind: 'video' | 'image'; path: string; asset: MediaAsset }
export interface Shot { text: string; query: string; start: number; duration: number; visual?: ShotVisual; variant: number }

export const MIN_SHOT = 2.5;
export const MAX_SHOT = 5.5;

/** Splits narration into sentences (Arabic + Latin punctuation). */
export function splitSentences(text: string): string[] {
  return (text.match(/[^.!؟?؛…\n]+[.!؟?؛…]*/g) ?? []).map((s) => s.trim()).filter((s) => countWords(s) > 0);
}

/**
 * Lays sentences over `duration` seconds proportionally to their word counts, merging very short
 * sentences into the next and splitting long ones into several shots (variant = which alternative clip).
 */
export function layoutShots(sentences: { text: string; query: string }[], duration: number): Shot[] {
  if (!sentences.length || duration <= 0) return [];
  const total = sentences.reduce((a, s) => a + Math.max(1, countWords(s.text)), 0);
  // 1) proportional durations
  let items = sentences.map((s) => ({ ...s, d: (duration * Math.max(1, countWords(s.text))) / total }));
  // 2) merge too-short items into their neighbour (keep the first query: it opens the idea)
  const merged: typeof items = [];
  for (const it of items) {
    const prev = merged.at(-1);
    if (prev && prev.d < MIN_SHOT) { prev.d += it.d; prev.text += ' ' + it.text; continue; }
    merged.push({ ...it });
  }
  if (merged.length > 1 && merged.at(-1)!.d < MIN_SHOT) { const last = merged.pop()!; merged.at(-1)!.d += last.d; merged.at(-1)!.text += ' ' + last.text; }
  items = merged;
  // 3) split long items into equal shots ≤ MAX_SHOT
  const shots: Shot[] = [];
  let t = 0;
  for (const it of items) {
    const parts = Math.max(1, Math.ceil(it.d / MAX_SHOT));
    for (let p = 0; p < parts; p++) {
      shots.push({ text: it.text, query: it.query, start: t, duration: it.d / parts, variant: p });
      t += it.d / parts;
    }
  }
  // absorb floating-point drift into the last shot
  const last = shots.at(-1)!;
  last.duration += duration - t;
  return shots;
}

const ShotQueriesLLM = z.object({ queries: z.array(z.object({ i: z.number().int(), query: z.string().min(2) })) });

/**
 * Asks the LLM for a concrete English stock-footage query per sentence (what to SHOW while it is said).
 * Falls back to the scene-level query when the model omits a sentence.
 */
export async function queriesForSentences(ctx: AgentContext, sentences: string[], fallback: string | string[], videoId: string): Promise<string[]> {
  if (!sentences.length) return [];
  const out = sentences.map((_, i) => (Array.isArray(fallback) ? fallback[i] ?? fallback[0] ?? 'documentary' : fallback));
  for (let i = 0; i < sentences.length; i += 60) {
    const batch = sentences.slice(i, i + 60);
    const res = await ctx.providers.llm.generateJson({
      task: 'production.shots',
      tier: 'light',
      system:
        'You are a documentary video editor. For EACH Arabic sentence give ONE concrete English stock-footage search query (2–5 words) describing what the viewer should SEE while it is spoken: real objects, places, actions (e.g. "old garage workshop", "warehouse packages conveyor", "smartphone touchscreen closeup"). No brand names, logos, celebrities or text. Vary the visuals; never repeat the same query twice in a row. Output JSON only.',
      prompt: JSON.stringify({ sentences: batch.map((s, j) => ({ i: i + j, text: s })) }),
      schema: ShotQueriesLLM,
      vars: { sentences: batch, offset: i },
      videoId,
      maxOutputTokens: 8000,
    }).catch(() => undefined);
    for (const q of res?.data.queries ?? []) if (q.i >= 0 && q.i < out.length) out[q.i] = q.query.replace(/[^\w\s-]/g, ' ').replace(/\s+/g, ' ').trim() || out[q.i]!;
  }
  return out;
}

/**
 * Fetches one clip per shot: shots that share a query take successive results (variant), and the same
 * clip is never used twice in one video when an alternative exists. Results are cached per query.
 */
export async function fetchShotVisuals(ctx: AgentContext, shots: Shot[], o: { targetWidth: number; orientation: 'landscape' | 'portrait'; cacheDir: string; used: Set<string>; notes: string[] }) {
  const stock = ctx.providers.stock;
  if (!stock.download) return;
  const results = new Map<string, MediaAsset[]>();
  const search = async (q: string) => {
    if (!results.has(q)) {
      const vids = await stock.search(q, 'video', { orientation: o.orientation, targetWidth: o.targetWidth, perPage: 12 }).catch(() => []);
      const imgs = vids.length >= 3 ? [] : await stock.search(q, 'image', { orientation: o.orientation, targetWidth: o.targetWidth, perPage: 8 }).catch(() => []);
      results.set(q, [...vids, ...imgs]);
    }
    return results.get(q)!;
  };
  let misses = 0;
  for (const s of shots) {
    const list = await search(s.query);
    const pick = list.find((a, idx) => !o.used.has(a.id) && idx >= Math.min(s.variant, list.length - 1)) ?? list.find((a) => !o.used.has(a.id)) ?? list[s.variant % Math.max(1, list.length)];
    if (!pick) { misses++; continue; }
    try {
      const path = await stock.download(pick, o.cacheDir);
      o.used.add(pick.id);
      s.visual = { kind: pick.kind === 'video' ? 'video' : 'image', path, asset: { ...pick, path } };
    } catch {
      misses++;
    }
  }
  if (misses) o.notes.push(`${misses}/${shots.length} shots had no matching stock clip (previous shot or a text card was used).`);
  // Never leave a gap: a shot without its own clip reuses the previous shot's visual.
  for (let i = 1; i < shots.length; i++) if (!shots[i]!.visual) shots[i]!.visual = shots[i - 1]!.visual;
}
