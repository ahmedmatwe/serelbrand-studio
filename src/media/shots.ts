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

const ShotQueriesLLM = z.object({ queries: z.array(z.object({ i: z.number().int(), query: z.string().min(2), alt: z.string().default(''), entity: z.string().default('') })) });

/** A shot query may carry a simpler fallback: "primary || alt". */
export const queryParts = (q: string) => q.split('||').map((x) => x.trim()).filter(Boolean);

const STOP = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'at', 'with', 'and', 'or', 'to', 'for', 'by', 'from', 'closeup', 'close', 'up', 'shot', 'footage', 'view', 'video']);
const stem = (w: string) => w.toLowerCase().replace(/(ies|es|s|ing|ed)$/, '');
/**
 * How many meaningful query words appear in the clip's tags (0 = unrelated). The head noun (last word, e.g.
 * "shop" in "small shop") must be among them — an adjective alone ("small" aquarium) never counts.
 * Undefined when the clip has no tags.
 */
export function relevance(asset: MediaAsset, query: string): number | undefined {
  if (!asset.tags?.length) return undefined;
  const tags = new Set(asset.tags.flatMap((t) => t.split(/\s+/)).map(stem));
  const words = query.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2 && !STOP.has(w)).map(stem);
  if (!words.length) return 0;
  if (words.length > 1 && !tags.has(words.at(-1)!)) return 0;
  return words.filter((w) => tags.has(w)).length;
}

/** Best unused clip for a query: relevant first (by tag overlap), then search order. Unrelated clips are never picked. */
export function pickRelevant(list: MediaAsset[], query: string, used: Set<string>, variant = 0): MediaAsset | undefined {
  const scored = list.map((a, idx) => ({ a, idx, r: relevance(a, query) }));
  const ok = scored.filter((x) => x.r === undefined || x.r > 0).sort((x, y) => (y.r ?? 0.5) - (x.r ?? 0.5) || x.idx - y.idx);
  const fresh = ok.filter((x) => !used.has(x.a.id));
  return (fresh[Math.min(variant, Math.max(0, fresh.length - 1))] ?? fresh[0] ?? ok[0])?.a;
}

/**
 * Asks the LLM for a concrete English stock-footage query per sentence (what to SHOW while it is said).
 * Falls back to the scene-level query when the model omits a sentence.
 */
export async function queriesForSentences(ctx: AgentContext, sentences: string[], fallback: string | string[], videoId: string, topic = ''): Promise<string[]> {
  if (!sentences.length) return [];
  const out = sentences.map((_, i) => (Array.isArray(fallback) ? fallback[i] ?? fallback[0] ?? 'documentary' : fallback));
  for (let i = 0; i < sentences.length; i += 60) {
    const batch = sentences.slice(i, i + 60);
    const res = await ctx.providers.llm.generateJson({
      task: 'production.shots',
      tier: 'light',
      system:
        'You are a documentary video editor choosing stock footage. For EACH Arabic sentence give: query = a concrete English stock-footage search (2–4 words) of what the viewer should literally SEE while it is spoken, and alt = a simpler 1–2 word fallback that surely exists in stock libraries. ' +
        'The query MUST contain the main concrete noun the sentence names or implies (price tag, shirt, cashier, factory, smartphone…). Rules: show real, filmable things (people, places, objects, actions) that match the sentence AND the video topic; turn abstract ideas into a literal scene (e.g. "humble beginnings" → "small garage workshop", "huge success" → "busy office team celebrating", "competition" → "chess game closeup"). ' +
        'Never abstract textures, crystals, particles, fractals or generic backgrounds. No brand names, logos, celebrities or on-screen text in query/alt. Vary the visuals; never repeat a query twice in a row. ' +
        'entity = if the sentence explicitly names a real person, company, product, building or place, its common English Wikipedia name (e.g. "Jeff Bezos", "Toyota Prius", "Amazon Spheres"); otherwise "". Output JSON only.',
      prompt: JSON.stringify({ videoTopic: topic, sentences: batch.map((s, j) => ({ i: i + j, text: s })) }),
      schema: ShotQueriesLLM,
      vars: { sentences: batch, offset: i },
      videoId,
      maxOutputTokens: 8000,
    }).catch(() => undefined);
    const clean = (x: string) => x.replace(/[^\w\s-]/g, ' ').replace(/\s+/g, ' ').trim();
    for (const q of res?.data.queries ?? []) if (q.i >= 0 && q.i < out.length && clean(q.query)) out[q.i] = [clean(q.entity) ? `wm:${clean(q.entity)}` : '', clean(q.query), clean(q.alt), out[q.i]!].filter(Boolean).join(' || ');
  }
  return out;
}

/**
 * Fetches one clip per shot: shots that share a query take successive results (variant), and the same
 * clip is never used twice in one video when an alternative exists. Results are cached per query.
 */
/** Relevant unused clips for a query, best first (tag overlap, then search order). Unrelated clips are dropped. */
export function rankRelevant(list: MediaAsset[], query: string, used: Set<string>): MediaAsset[] {
  return list.map((a, idx) => ({ a, idx, r: relevance(a, query) }))
    .filter((x) => (x.r === undefined || x.r > 0) && !used.has(x.a.id))
    .sort((x, y) => (y.r ?? 0.5) - (x.r ?? 0.5) || x.idx - y.idx)
    .map((x) => x.a);
}

const PickLLM = z.object({ picks: z.array(z.object({ shot: z.number().int(), ok: z.array(z.number().int()).default([]), why: z.string().default('') })) });

async function previewImage(url: string): Promise<{ mimeType: string; data: string } | undefined> {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return undefined;
    const res = await fetch(u, { headers: { 'user-agent': 'SerElBrandStudio/1.0 (shot matching)' }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return undefined;
    const type = (res.headers.get('content-type') ?? '').split(';')[0]!;
    if (!/^image\/(jpeg|png|webp)$/.test(type)) return undefined;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 400_000) return undefined;
    return { mimeType: type, data: buf.toString('base64') };
  } catch { return undefined; }
}

/**
 * Lets a vision model LOOK at the candidate previews and pick, for each shot, the one that literally shows
 * what the narrator says at that moment (or none). Returns shot index → candidate index (-1 = none fits).
 */
export async function pickByVision(ctx: AgentContext, items: { text: string; candidates: MediaAsset[] }[], videoId?: string): Promise<Map<number, number[]>> {
  const out = new Map<number, number[]>();
  if (ctx.providers.llm.name.startsWith('mock')) return out;
  for (let b = 0; b < items.length; b += 2) {
    const batch = items.slice(b, b + 2);
    const images: { mimeType: string; data: string; label: string }[] = [];
    const lines: string[] = [];
    const maps: Map<number, number>[] = [];
    for (const [k, it] of batch.entries()) {
      const map = new Map<number, number>();
      let n = 0;
      for (const [ci, c] of it.candidates.entries()) {
        const im = c.previewUrl ? await previewImage(c.previewUrl) : undefined;
        if (!im) continue;
        n++;
        map.set(n, ci);
        images.push({ ...im, label: `Shot ${k + 1} — candidate ${n}:` });
      }
      maps.push(map);
      lines.push(`Shot ${k + 1}: narration (Arabic): "${it.text}" — ${n} candidate images.`);
    }
    if (!images.length) continue;
    const r = await ctx.providers.llm.generateJson({
      task: 'shots.pick',
      tier: 'light',
      system: 'You are a strict documentary film editor. Each image is preceded by a label "Shot X — candidate N". For each shot list ALL candidates that fit, best first, i.e. that show what the narrator says at that moment: the concrete thing named (a price tag, a shirt, a cashier, a factory, the named product or person) or the exact place/action where it happens (a supermarket aisle fits "a price on a supermarket shelf"). Never list a scene unrelated to the sentence (fish, nature, music, random people) — return an empty list when none fits. JSON only.',
      prompt: lines.join('\n') + '\nReturn {"picks":[{"shot":1,"ok":[<candidate numbers that fit, best first>],"why":"…"}]}',
      schema: PickLLM,
      images,
      videoId,
      maxOutputTokens: 1500,
    }).catch(() => undefined);
    if (!r) continue; // vision unavailable for this batch → tag-ranked order is used
    for (const [k] of batch.entries()) {
      const p = r.data.picks.find((x) => x.shot === k + 1);
      // A missing answer means "no fitting image" — never a blind pick.
      out.set(b + k, (p?.ok ?? []).map((n) => maps[k]!.get(n)).filter((x): x is number => x !== undefined));
    }
  }
  return out;
}

export async function fetchShotVisuals(ctx: AgentContext, shots: Shot[], o: { targetWidth: number; orientation: 'landscape' | 'portrait'; cacheDir: string; used: Set<string>; notes: string[]; videoId?: string }) {
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
  const photos = ctx.providers.photos;
  const photoResults = new Map<string, MediaAsset[]>();
  const photoSearch = async (q: string) => {
    if (!photoResults.has(q)) photoResults.set(q, await photos!.search(q, 'image', { perPage: 10, targetWidth: o.targetWidth }).catch(() => []));
    return photoResults.get(q)!;
  };
  // 1) Candidates per shot: real photos of a named entity first, then clips for each query, relevant only.
  const cands: MediaAsset[][] = [];
  for (const s of shots) {
    const list: MediaAsset[] = [];
    for (const q of queryParts(s.query)) {
      if (list.length >= 6) break;
      if (q.startsWith('wm:')) {
        const entity = q.slice(3);
        if (!photos?.download) continue;
        const need = entity.split(/\s+/).filter((w) => w.length > 2).length;
        const found = (await photoSearch(entity)).filter((a) => (relevance(a, entity) ?? 0) >= Math.min(2, Math.max(1, need)));
        list.push(...rankRelevant(found, entity, o.used).slice(0, 2));
        continue;
      }
      const ranked = rankRelevant(await search(q), q, o.used);
      list.push(...ranked.slice(s.variant, s.variant + 3), ...ranked.slice(0, s.variant).slice(0, 1));
    }
    cands.push([...new Map(list.map((a) => [a.id, a])).values()].slice(0, 6));
  }
  // 2) Look at them: the vision model picks what matches the narration (or rejects all).
  const vision = await pickByVision(ctx, shots.map((s, i) => ({ text: s.text, candidates: cands[i]! })), o.videoId);
  const judged = vision.size > 0;
  // 2b) One more round for rejected shots: new, different searches, looked at again.
  const rejectedIdx = [...vision.entries()].filter(([, v]) => !v.length).map(([i]) => i);
  if (rejectedIdx.length) {
    const retry = await ctx.providers.llm.generateJson({
      task: 'production.shots.retry',
      tier: 'light',
      system: 'Stock-footage searches failed for these Arabic sentences. For each, give 2 NEW, different English stock-video queries (2–3 words, very common filmable things that surely exist in free stock libraries: e.g. "cashier counter", "shopping bags", "price label", "folded shirts", "office meeting", "counting money"). JSON only.',
      prompt: JSON.stringify({ shots: rejectedIdx.map((i) => ({ i, text: shots[i]!.text, failed: shots[i]!.query })) }),
      schema: z.object({ shots: z.array(z.object({ i: z.number().int(), queries: z.array(z.string()).min(1) })) }),
      videoId: o.videoId,
      maxOutputTokens: 2000,
    }).catch(() => undefined);
    const items: { i: number; text: string; candidates: MediaAsset[] }[] = [];
    for (const r of retry?.data.shots ?? []) {
      if (!rejectedIdx.includes(r.i)) continue;
      const list: MediaAsset[] = [];
      for (const q of r.queries.slice(0, 2)) list.push(...rankRelevant(await search(q.replace(/[^\w\s-]/g, ' ').trim()), q, o.used).slice(0, 3));
      cands[r.i] = [...new Map(list.map((a) => [a.id, a])).values()].slice(0, 6);
      items.push({ i: r.i, text: shots[r.i]!.text, candidates: cands[r.i]! });
    }
    const second = await pickByVision(ctx, items, o.videoId);
    for (const [k, v] of second) vision.set(items[k]!.i, v);
  }
  // 3) Assign, never reusing a clip.
  let misses = 0, rejected = 0;
  for (const [i, s] of shots.entries()) {
    const v = vision.get(i);
    // Judged by vision → only the candidates it approved; not judged (no previews / vision down) → tag order.
    const order = v ? v.map((k) => cands[i]![k]!) : cands[i]!;
    if (v && !v.length) { rejected++; misses++; continue; }
    const pick = order.find((a) => !o.used.has(a.id));
    if (!pick) { misses++; continue; }
    try {
      const from = pick.source === 'wikimedia' && photos?.download ? photos : stock;
      const path = await from.download!(pick, o.cacheDir);
      o.used.add(pick.id);
      s.visual = { kind: pick.kind === 'video' ? 'video' : 'image', path, asset: { ...pick, path } };
    } catch {
      misses++;
    }
  }
  if (judged) o.notes.push(`Shots chosen by looking at the candidates (vision): ${shots.length - misses}/${shots.length} matched, ${rejected} had no fitting image.`);
  if (misses) o.notes.push(`${misses}/${shots.length} shots had no matching stock clip (previous shot or a text card was used).`);
  // Never leave a gap: a shot without its own clip reuses the previous shot's visual.
  for (let i = 1; i < shots.length; i++) if (!shots[i]!.visual) shots[i]!.visual = shots[i - 1]!.visual;
}
