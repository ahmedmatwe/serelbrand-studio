/**
 * Title editor: the title decides whether people tap. For every Short it writes 5 different titles, scores them
 * (clear benefit within 2 seconds, curiosity, the words people search: app/phone names), and picks the best —
 * guided by the titles that actually got views on our channel and the analyst's title rules.
 */
import { z } from 'zod';
import type { AgentContext } from './base.ts';
import { allPosts, scorePosts } from '../analytics/learner.ts';

const Choice = z.object({
  shorts: z.array(z.object({
    n: z.number().int(),
    candidates: z.array(z.object({ title: z.string().min(5).max(90), style: z.string().max(40), score: z.number().min(0).max(10) })).min(3).max(6),
    best: z.string().min(5).max(90),
  })),
});
export interface TitleChoice { n: number; from: string; to: string; style?: string; candidates: { title: string; style: string; score: number }[] }

const strip = (t?: string | null) => (t ?? '').replace(/\s*#Shorts$/, '').trim();

/** What our own numbers say about titles: the best and the weakest recent ones, plus the analyst's rules. */
export function titleEvidence(ctx: AgentContext) {
  const scored = scorePosts(allPosts(ctx)).sort((a, b) => b.score - a.score);
  const fmt = (x: (typeof scored)[number]) => `${strip(x.post.title)} (${x.post.platform}, ×${Math.exp(x.score).toFixed(1)} usual views)`;
  return {
    titlesThatWorked: scored.filter((x) => x.score > 0.2).slice(0, 6).map(fmt),
    titlesThatDidNot: scored.filter((x) => x.score < -0.5).slice(-6).map(fmt),
    titleRules: ctx.repos.knowledge.byCategory('lesson').map((k) => k.insight).filter((x) => /^Performance \((title|hook)/.test(x)).slice(0, 4),
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
      'Every title must be TRUE to the narration (never promise what the Short does not deliver, never add facts) and name the app/phone when the narration does (people search "واتساب", "آيفون", "سامسونج"). ' +
      'Score each 0–10 for: understood in 2 seconds, makes the viewer curious, says what they gain, matches what people search. Learn from titlesThatWorked / titlesThatDidNot and follow titleRules. ' +
      'best = the highest-scoring title. JSON only.',
    prompt: JSON.stringify({ shorts: shorts.map((s) => ({ n: s.n, currentTitle: s.title, narration: s.narration, onScreen: s.onScreen })), ...titleEvidence(ctx) }),
    schema: Choice,
    videoId,
    maxOutputTokens: 3000,
  }).catch(() => undefined);
  if (!r) return [];
  const out: TitleChoice[] = [];
  for (const s of (r.data as z.infer<typeof Choice>).shorts) {
    const orig = shorts.find((x) => x.n === s.n);
    const best = s.best.replace(/#\S+/g, '').trim();
    if (!orig || best.length < 5 || best.length > 90) continue;
    out.push({ n: s.n, from: orig.title, to: best, style: s.candidates.find((c) => c.title.trim() === s.best.trim())?.style, candidates: s.candidates });
  }
  return out;
}
