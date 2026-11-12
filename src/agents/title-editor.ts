/**
 * Title editor: the title decides whether people tap. For every Short it writes 5 different titles, scores them
 * (clear benefit within 2 seconds, curiosity, the words people search: app/phone names), and picks the best —
 * guided by the titles that actually got views on our channel and the analyst's title rules.
 */
import { z } from 'zod';
import type { AgentContext } from './base.ts';
import { allPosts, scorePosts } from '../analytics/learner.ts';
import { guardCodes } from '../publishing/social.ts';
import { vaguePenalty } from './text/vague.ts';

const Choice = z.object({
  shorts: z.array(z.object({
    n: z.number().int(),
    candidates: z.array(z.object({ title: z.string().min(5).max(90), style: z.string().max(40), score: z.number().min(0).max(10) })).min(3).max(6),
    best: z.string().min(5).max(90),
    /** Each platform's own headline (first line of its caption), written for how that platform ranks videos. */
    platforms: z.object({ tiktok: z.string().min(5).max(100), instagram: z.string().min(5).max(100), facebook: z.string().min(5).max(120) }).partial().default({}),
  })),
});
export type Headlines = Partial<Record<'tiktok' | 'instagram' | 'facebook', string>>;
export interface TitleChoice { n: number; from: string; to: string; style?: string; candidates: { title: string; style: string; score: number }[]; platforms?: Headlines }

const strip = (t?: string | null) => (t ?? '').replace(/\s*#Shorts$/, '').trim();
/** Removes hashtags (#word) but never phone codes like *#06# or #31#. */
const noTags = (t: string) => t.replace(/(^|\s)#[^\s\d*#][^\s]*/g, '$1').replace(/\s{2,}/g, ' ').trim();

/**
 * What our own numbers say about titles, PER PLATFORM: the headline each platform actually showed (from earlier
 * title choices) with its views vs that platform's usual, best and weakest; plus the analyst's title rules.
 */
export function titleEvidence(ctx: AgentContext) {
  const shown = new Map<string, Headlines & { youtube: string }>();
  for (const a of ctx.repos.artifacts.listKind<{ picks: TitleChoice[] }>('title_choices')) for (const p of a.data.picks) shown.set(strip(p.to), { youtube: p.to, ...(p.platforms ?? {}) });
  const scored = scorePosts(allPosts(ctx)).sort((a, b) => b.score - a.score);
  const per: Record<string, { worked: string[]; didNot: string[] }> = {};
  for (const pl of ['youtube', 'tiktok', 'instagram', 'facebook'] as const) {
    const own = scored.filter((x) => x.post.platform === pl);
    const name = (x: (typeof own)[number]) => `${(shown.get(strip(x.post.title)) as Record<string, string> | undefined)?.[pl] ?? strip(x.post.title)} (×${Math.exp(x.score).toFixed(1)} usual views)`;
    per[pl] = { worked: own.filter((x) => x.score > 0.2).slice(0, 5).map(name), didNot: own.filter((x) => x.score < -0.5).slice(-5).map(name) };
  }
  return {
    evidencePerPlatform: per,
    titleRules: ctx.repos.knowledge.byCategory('lesson').map((k) => k.insight).filter((x) => /^Performance \((title|hook|caption)/.test(x)).slice(0, 6),
  };
}

/** Best title per Short; any Short the model can't handle keeps its title. Never throws. */
export async function chooseTitles(ctx: AgentContext, shorts: { n: number; title: string; narration: string; onScreen?: string }[], videoId?: string): Promise<TitleChoice[]> {
  if (!shorts.length) return [];
  const r = await ctx.providers.llm.generateJson({
    task: 'titles.choose',
    tier: 'writing',
    system: 'You are the title editor of "سر الموبايل", an Egyptian Arabic channel of short phone/app secrets (YouTube Shorts, Facebook and Instagram Reels). ' +
      'For EACH Short write 5 genuinely different titles in natural Egyptian Arabic (≤ 60 characters, no hashtags, at most one emoji): e.g. a clear personal benefit, a warning, a surprising "you didn\'t know", a question, a number. ' +
      'Name the exact thing: the app/phone plus the concrete feature or result the viewer can picture (our best titles: "الآيفون فيه أصوات مطر وبحر مخفية تساعدك تنام", "كود أندرويد بيفتحلك قائمة اختبار مخفية"); vague fear or "do this" titles flopped ("لو معملتش كدة واتساب بتاعك ممكن يتسرق بسهولة" got half the usual views) — never "الحركة دي / كده / بسهولة" or abstract safety words without the concrete thing. ' +
      'Every title must be TRUE to the narration (never promise what the Short does not deliver, never add facts) and name the app/phone when the narration does (people search "واتساب", "آيفون", "سامسونج"). ' +
      'Score each 0–10 for: understood in 2 seconds, makes the viewer curious, says what they gain, matches what people search. ' +
      'best = the highest-scoring title (used on YouTube Shorts: put the searched words — app/phone + benefit — in the first half, ≤ 60 chars). ' +
      'platforms = a separate headline for each platform, written for how its algorithm ranks videos: ' +
      'tiktok: a scroll-stopping hook in TikTok\'s spoken style plus the words people type in TikTok search (≤ 70 chars, a question or "you didn\'t know" works); ' +
      'instagram: the first line shown before "more" (≤ 10 words) — curiosity plus a save-worthy promise, keywords for Instagram search; ' +
      'facebook: conversational and relatable, ideally a question that invites comments (≤ 90 chars). ' +
      'Learn separately from evidencePerPlatform (what worked on THAT platform) and follow titleRules. JSON only.',
    prompt: JSON.stringify({ shorts: shorts.map((s) => ({ n: s.n, currentTitle: s.title, narration: s.narration, onScreen: s.onScreen })), ...titleEvidence(ctx) }),
    schema: Choice,
    videoId,
    maxOutputTokens: 3000,
  }).catch(() => undefined);
  if (!r) return [];
  const out: TitleChoice[] = [];
  for (const s of (r.data as z.infer<typeof Choice>).shorts) {
    const orig = shorts.find((x) => x.n === s.n);
    // Re-rank: the model's score minus a vagueness penalty (concrete titles win on our channel).
    const ranked = [...s.candidates].map((c) => ({ ...c, adj: c.score - vaguePenalty(c.title) })).sort((a, b) => b.adj - a.adj);
    const pickTitle = ranked[0] && ranked[0].adj > (s.candidates.find((c) => c.title.trim() === s.best.trim())?.score ?? 0) - vaguePenalty(s.best) + 0.01 ? ranked[0].title : s.best;
    const best = noTags(pickTitle);
    if (!orig || best.length < 5 || best.length > 90) continue;
    // Phone codes in any headline must be exactly the narration's (models sometimes write them backwards).
    const platforms: Headlines = {};
    for (const [pl, h] of Object.entries(s.platforms ?? {}) as [keyof Headlines, string][]) { const g = h ? guardCodes(noTags(h), orig.narration) : undefined; if (g && g.length >= 5) platforms[pl] = g; }
    const safeBest = guardCodes(best, orig.narration);
    if (!safeBest) continue;
    out.push({ n: s.n, from: orig.title, to: safeBest, style: s.candidates.find((c) => c.title.trim() === pickTitle.trim())?.style, candidates: s.candidates, platforms });
  }
  return out;
}
