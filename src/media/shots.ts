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
export function layoutShots(sentences: { text: string; query: string; /** Measured start (s) of the sentence in the audio. */ start?: number }[], duration: number, maxShot = MAX_SHOT): Shot[] {
  if (!sentences.length || duration <= 0) return [];
  const total = sentences.reduce((a, s) => a + Math.max(1, countWords(s.text)), 0);
  // 1) durations: from the measured sentence starts when known (cuts land where the sentence is spoken),
  //    else proportional to word count.
  const timed = sentences.every((s) => s.start !== undefined && Number.isFinite(s.start));
  const edge = (i: number) => (i === 0 ? 0 : i >= sentences.length ? duration : Math.min(duration, Math.max(0, sentences[i]!.start! - 0.1)));
  let items = sentences.map((s, i) => ({ ...s, d: timed ? Math.max(0.05, edge(i + 1) - edge(i)) : (duration * Math.max(1, countWords(s.text))) / total }));
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
    const parts = Math.max(1, Math.ceil(it.d / Math.max(MIN_SHOT, maxShot)));
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
        'You are a documentary video editor choosing stock footage for a family channel. Prefer phones, screens, hands, objects and places over people; never people in bed, swimwear, parties or anything suggestive. For EACH Arabic sentence give: query = a concrete English stock-footage search (2–4 words) of what the viewer should literally SEE while it is spoken, and alt = a simpler 1–2 word fallback that surely exists in stock libraries. ' +
        'The query MUST contain the main concrete noun the sentence names or implies (price tag, shirt, cashier, factory, smartphone…). Rules: show real, filmable things (people, places, objects, actions) that match the sentence AND the video topic; turn abstract ideas into a literal scene (e.g. "humble beginnings" → "small garage workshop", "huge success" → "busy office team celebrating", "competition" → "chess game closeup"). ' +
        'Never abstract textures, crystals, particles, fractals or generic backgrounds. No brand names, logos, celebrities or on-screen text in query/alt. The FIRST sentence is the hook: return a literal, instantly understandable visual for it; never return a generic documentary, landscape, person, or abstract background. If a sentence has no safe literal visual, use an object/action from its concrete example instead. Vary the visuals; never repeat a query twice in a row. ' +
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

/**
 * Channel standard for an Egyptian / Arab family audience: every shot must be modest. Used by every visual check.
 */
/** Raw production footage that looks amateur on screen (chroma-key plates, tracking markers, watermarks). */
export const RAW_FOOTAGE = /\b(green ?screen|greenscreen|chroma ?key|chromakey|blue ?screen|tracking ?markers?|mock ?up|mockup|watermark)\b/i;
export const isRawFootage = (a: MediaAsset) => RAW_FOOTAGE.test((a.tags ?? []).join(' '));
export const LOOK_RULE = 'LOOK: also reject unfinished production footage — green/blue screens (chroma key), screens with tracking markers or crosses, mockup templates, watermarks, blank or black screens.';
export const MODESTY_RULE = 'MODESTY (absolute, overrides relevance): reject any image showing revealing or tight clothing — sleeveless or strappy tops, camisoles, bare shoulders, cleavage, bare midriff, shorts or short skirts, swimwear, lingerie, people in bed or bedroom/intimate settings, couples being intimate, dancing, nightclubs, alcohol, gambling or anything suggestive. People are acceptable only when fully and modestly dressed (or only hands/arms in normal sleeves are visible). Prefer shots of phones, screens, hands, objects and places.';

/** Max shots per video checked by vision (each request carries 2 shots × up to 6 small previews). */
export const VISION_BUDGET = 60;

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
/** The analyst's and the editing critic's lessons about visuals, for whoever picks shots. */
export function visualLessons(ctx: AgentContext): string {
  const l = ctx.repos?.knowledge?.byCategory?.('lesson')?.map((k) => k.insight).filter((x) => /^Performance \((visuals|shots|editing)/.test(x)).slice(0, 4) ?? [];
  return l.length ? ` LESSONS FROM OUR REAL VIEW COUNTS (apply them when choosing): ${l.map((x) => x.replace(/^Performance \([^)]*\):\s*/, '')).join(' | ')}.` : '';
}

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
      system: MODESTY_RULE + ' ' + LOOK_RULE + visualLessons(ctx) + ' You are a strict documentary film editor. Each image is preceded by a label "Shot X — candidate N". For each shot list ALL candidates that fit (and pass the modesty rule), best first, i.e. that show what the narrator says at that moment: the concrete thing named (a price tag, a shirt, a cashier, a factory, the named product or person) or the exact place/action where it happens (a supermarket aisle fits "a price on a supermarket shelf"). Never list a scene unrelated to the sentence (fish, nature, music, random people) — return an empty list when none fits. JSON only.',
      prompt: lines.join('\n') + '\nReturn {"picks":[{"shot":1,"ok":[<candidate numbers that fit, best first>],"why":"…"}]}',
      schema: PickLLM,
      images,
      videoId,
      maxOutputTokens: 1500,
    }).catch(() => undefined);
    // Vision unavailable (e.g. free quota used up): stop asking for the rest of this video → tag-ranked order.
    if (!r) break;
    for (const [k] of batch.entries()) {
      const p = r.data.picks.find((x) => x.shot === k + 1);
      // A missing answer means "no fitting image" — never a blind pick.
      out.set(b + k, (p?.ok ?? []).map((n) => maps[k]!.get(n)).filter((x): x is number => x !== undefined));
    }
  }
  return out;
}

export async function fetchShotVisuals(ctx: AgentContext, shots: Shot[], o: { targetWidth: number; orientation: 'landscape' | 'portrait'; cacheDir: string; used: Set<string>; notes: string[]; videoId?: string; /** Broad, always-relevant searches (e.g. "smartphone screen") used for shots nothing specific fits. */ fallbackQueries?: string[] }) {
  const stock = ctx.providers.stock;
  if (!stock.download) return;
  const results = new Map<string, MediaAsset[]>();
  const search = async (q: string) => {
    if (!results.has(q)) {
      const vids = await stock.search(q, 'video', { orientation: o.orientation, targetWidth: o.targetWidth, perPage: 12 }).catch(() => []);
      const imgs = vids.length >= 1 ? [] : await stock.search(q, 'image', { orientation: o.orientation, targetWidth: o.targetWidth, perPage: 8 }).catch(() => []);
      results.set(q, [...vids, ...imgs].filter((a) => !isRawFootage(a)));
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
  // 2) Look at them: the vision model picks what matches the narration (or rejects all). Budget: at most
  //    VISION_BUDGET shots per video (free quota), the least certain ones first (weak/no tag match).
  const certainty = (i: number) => { const c = cands[i]![0]; return c ? relevance(c, queryParts(shots[i]!.query).find((q) => !q.startsWith('wm:')) ?? '') ?? 0 : 9; };
  const judgedIdx = shots.map((_, i) => i).filter((i) => cands[i]!.length > 0).sort((a, b) => certainty(a) - certainty(b) || a - b).slice(0, VISION_BUDGET).sort((a, b) => a - b);
  const vis0 = await pickByVision(ctx, judgedIdx.map((i) => ({ text: shots[i]!.text, candidates: cands[i]! })), o.videoId);
  const vision = new Map<number, number[]>([...vis0].map(([k, v]) => [judgedIdx[k]!, v]));
  const judged = vision.size > 0;
  // 2b) One more round for rejected shots: new, different searches, looked at again.
  const rejectedIdx = [...vision.entries()].filter(([, v]) => !v.length).map(([i]) => i);
  if (rejectedIdx.length) {
    const retry = await ctx.providers.llm.generateJson({
      task: 'production.shots.retry',
      tier: 'light',
      system: 'Family channel: queries for objects, hands, phones and places only (no people in bed, swimwear or parties). Stock-footage searches failed for these Arabic sentences. For each, give 2 NEW, different English stock-video queries (2–3 words, very common filmable things that surely exist in free stock libraries: e.g. "cashier counter", "shopping bags", "price label", "folded shirts", "office meeting", "counting money"). JSON only.',
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
  // 4) Never leave a hole: shots nothing specific fits get an unused clip from the channel's broad topic
  //    searches (always on-topic, e.g. a phone in hand), instead of an empty coloured card.
  let filled = 0;
  for (const q of o.fallbackQueries ?? []) {
    const open = shots.filter((s) => !s.visual);
    if (!open.length) break;
    // Fallback clips skip the relevance check, never the modesty check.
    const pool = await modestOnly(ctx, rankRelevant(await search(q), q, o.used).slice(0, 8), o.videoId);
    for (const a of pool) {
      const s = shots.find((x) => !x.visual);
      if (!s) break;
      try {
        const path = await stock.download!(a, o.cacheDir);
        o.used.add(a.id);
        s.visual = { kind: a.kind === 'video' ? 'video' : 'image', path, asset: { ...a, path } };
        filled++;
      } catch { /* try the next clip */ }
    }
  }
  // Last guarantee: a Short must never show an empty coloured card. If nothing at all was found for this set
  // of shots, re-use the best on-topic clip (even one already used elsewhere) for the first shot; the renderer
  // then stretches neighbouring footage over any remaining gaps.
  if (!shots.some((s) => s.visual)) {
    for (const q of o.fallbackQueries ?? []) {
      const a = (await search(q)).find((x) => (relevance(x, q) ?? 1) > 0);
      if (!a) continue;
      try { const path = await stock.download!(a, o.cacheDir); shots[0]!.visual = { kind: a.kind === 'video' ? 'video' : 'image', path, asset: { ...a, path } }; filled++; break; } catch { /* next */ }
    }
  }
  if (filled) o.notes.push(`${filled} shot(s) without a specific match got a general on-topic clip.`);
  if (judged) o.notes.push(`Shots chosen by looking at the candidates (vision): ${shots.length - misses}/${shots.length} matched, ${rejected} had no fitting image.`);
  if (misses) o.notes.push(`${misses}/${shots.length} shots had no matching stock clip (previous shot or a text card was used).`);
  // Never hide a mismatch by reusing an unrelated previous shot. Missing visuals become an intentional
  // narration-led text card in the renderer; the opening is never allowed to inherit another scene's footage.
  const missing = shots.map((s, i) => (!s.visual ? i + 1 : 0)).filter(Boolean);
  if (missing.length) o.notes.push(`Intentional text-card fallback for unmatched shots: ${missing.join(', ')}.`);
}

/**
 * Keeps only candidates a vision model confirms as modest (see MODESTY_RULE). When vision is unavailable the
 * list is returned unchanged — the rendered-video audit (auditFrames) is the final safety net.
 */
export async function modestOnly(ctx: AgentContext, list: MediaAsset[], videoId?: string): Promise<MediaAsset[]> {
  if (!list.length || ctx.providers.llm.name.startsWith('mock')) return list;
  const images: { mimeType: string; data: string; label: string }[] = [];
  const idx: number[] = [];
  for (const [i, a] of list.entries()) {
    const im = a.previewUrl ? await previewImage(a.previewUrl) : undefined;
    if (im) { images.push({ ...im, label: `Image ${images.length + 1}:` }); idx.push(i); }
  }
  if (!images.length) return [];
  const r = await ctx.providers.llm.generateJson({
    task: 'shots.modesty',
    tier: 'light',
    system: `${MODESTY_RULE} ${LOOK_RULE} For each numbered image say whether it passes. JSON only: {"pass":[image numbers that pass]}`,
    prompt: 'Which images pass the modesty rule?',
    schema: z.object({ pass: z.array(z.number().int()).default([]) }),
    images,
    videoId,
    maxOutputTokens: 400,
  }).catch(() => undefined);
  if (!r) return list;
  return r.data.pass.map((n) => idx[n - 1]).filter((i): i is number => i !== undefined).map((i) => list[i]!);
}

/**
 * Final safety net on the RENDERED video: frames every 2 s are shown to the vision model; any immodest frame
 * returns a reason (the Short is then held back from publishing). Undefined = clean (or vision unavailable).
 */
/**
 * Frame audit of a rendered video. `frames` = immodest frames (the Short is held back if they can't be replaced);
 * `raw` = unfinished stock footage (green/blue screen, tracking markers, mockup, watermark): replaced, never held.
 */
export async function auditFrames(ctx: AgentContext, framesJpeg: Buffer[], videoId?: string): Promise<{ reason: string; frames: number[]; raw?: number[] } | undefined> {
  if (!framesJpeg.length || ctx.providers.llm.name.startsWith('mock')) return undefined;
  const bad: number[] = [];
  const raw: number[] = [];
  let reason = '';
  for (let i = 0; i < framesJpeg.length; i += 12) {
    const batch = framesJpeg.slice(i, i + 12);
    const r = await ctx.providers.llm.generateJson({
      task: 'video.modesty_audit',
      tier: 'light',
      system: `${MODESTY_RULE} These are frames of one short video, numbered. Separately list in "raw" the frames that show unfinished stock footage: a flat green or blue chroma-key screen, tracking markers/crosses on a screen, a mockup template, or a watermark (a drawn phone screen with settings or a dialer is NOT raw — it is ours). JSON only: {"fail":[numbers of frames that fail modesty],"raw":[numbers],"reason":"what is wrong"}`,
      prompt: 'List every frame that fails the modesty rule, and every raw-footage frame (empty lists if all pass).',
      schema: z.object({ fail: z.array(z.number().int()).default([]), raw: z.array(z.number().int()).default([]), reason: z.string().default('') }),
      images: batch.map((b, k) => ({ mimeType: 'image/jpeg', data: b.toString('base64'), label: `Frame ${i + k + 1}:` })),
      videoId,
      maxOutputTokens: 300,
    }).catch(() => undefined);
    if (r?.data.fail.length) { bad.push(...r.data.fail); reason ||= r.data.reason; }
    if (r?.data.raw.length) { raw.push(...r.data.raw); reason ||= r.data.reason; }
  }
  const uniq = (xs: number[]) => [...new Set(xs)].sort((a, b) => a - b);
  return bad.length || raw.length ? { reason: reason || (bad.length ? 'immodest frame' : 'raw stock footage'), frames: uniq(bad), raw: uniq(raw) } : undefined;
}

/**
 * Editing critic: watches a rendered Short (a frame every 2 s, with what is said at that second) like a senior
 * editor and scores the opening, how well each shot shows what is said, pacing and caption readability (0–10).
 * `mismatchAt` = seconds whose shot does not show what is said — those shots get replaced at once.
 */
export const EditReview = z.object({
  hook: z.number().min(0).max(10), visualMatch: z.number().min(0).max(10), pacing: z.number().min(0).max(10), captions: z.number().min(0).max(10),
  mismatchAt: z.array(z.number()).default([]), notes: z.string().max(600).default(''),
});
export type EditReviewResult = z.infer<typeof EditReview>;
export async function critiqueEdit(ctx: AgentContext, framesJpeg: Buffer[], said: { at: number; text: string }[], videoId?: string): Promise<EditReviewResult | undefined> {
  if (!framesJpeg.length || ctx.providers.llm.name.startsWith('mock')) return undefined;
  const r = await ctx.providers.llm.generateJson({
    task: 'video.edit_review',
    tier: 'light',
    system: 'You are a senior short-form video editor reviewing a 30–45 s Egyptian Arabic phone-secret Short before it is published. Frame N is at second (N-1)*2. ' +
      'Score 0–10: hook = do the first 2 frames make a scroller stop (clear subject, a phone/screen, motion, readable promise)? visualMatch = does each frame show what is said at that second? pacing = varied, not the same clip for long, no dead/blank frames? captions = readable, not covering the important part? ' +
      'mismatchAt = the seconds whose picture clearly does NOT show what is being said (e.g. nature while talking about a code). notes = the 1–3 most useful fixes for next time, concrete. JSON only.' + visualLessons(ctx),
    prompt: JSON.stringify({ saidAtSecond: said }),
    schema: EditReview,
    images: framesJpeg.slice(0, 24).map((b, k) => ({ mimeType: 'image/jpeg', data: b.toString('base64'), label: `Frame ${k + 1}:` })),
    videoId,
    maxOutputTokens: 600,
  }).catch(() => undefined);
  return r?.data as EditReviewResult | undefined;
}
