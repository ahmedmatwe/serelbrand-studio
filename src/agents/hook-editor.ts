/**
 * Hook editor: the first two seconds decide whether a Short is watched. For every Short it writes 5 different
 * opening lines (shock benefit, warning/loss, "nobody tells you", challenge, result-first…), scores them and puts
 * the strongest one first in the narration — learning from our own numbers: which openings kept viewers past
 * the first seconds (YouTube retention) and got more views than usual, and which lost them.
 * The hook must be TRUE to the rest of the Short (it promises only what the Short delivers).
 */
import { z } from 'zod';
import type { AgentContext } from './base.ts';
import { allPosts } from '../analytics/learner.ts';
import { buildPerformance } from '../analytics/analyst.ts';

const Choice = z.object({
  shorts: z.array(z.object({
    n: z.number().int(),
    candidates: z.array(z.object({ hook: z.string().min(5).max(110), pattern: z.string().max(30), score: z.number().min(0).max(10) })).min(3).max(6),
    best: z.string().min(5).max(110),
    /** One short sentence after the hook that keeps what the replaced first sentence told (e.g. "it's a code"). */
    bridge: z.string().max(110).default(''),
  })),
});
export interface HookChoice { n: number; from: string; to: string; bridge?: string; pattern?: string; candidates: { hook: string; pattern: string; score: number }[] }

/**
 * Evolution of hook styles: for each pattern, how well its openings kept viewers (YouTube keptAfterOpening,
 * else views vs usual) and which patterns the last Shorts used (so openings don't all sound alike).
 */
export function hookPatternStats(ctx: AgentContext, now = new Date()) {
  const choices = ctx.repos.artifacts.listKind<{ picks: HookChoice[] }>('hook_choices').flatMap((a) => a.data.picks);
  const patternOf = new Map(choices.map((c) => [c.to.trim(), c.pattern ?? '']));
  const perf = buildPerformance(ctx, allPosts(ctx), now);
  const by: Record<string, number[]> = {};
  for (const s of perf) {
    const pat = s.hook ? patternOf.get(s.hook.trim()) : undefined;
    if (!pat) continue;
    const kept = s.whereViewersLeft?.keptAfterOpening;
    const vs = s.results.length ? s.results.reduce((a, r) => a + r.vsPlatformUsual, 0) / s.results.length : 1;
    (by[pat] ??= []).push(kept ?? Math.min(1, 0.5 * vs));
  }
  const stats = Object.fromEntries(Object.entries(by).map(([k, xs]) => [k, { n: xs.length, score: Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2)) }]));
  return { stats, recent: choices.slice(-3).map((c) => c.pattern ?? '').filter(Boolean) };
}

/**
 * The strongest, varied pick: candidates within 0.6 of the top score; a pattern proven weak (≥ 3 Shorts, clearly
 * below the best pattern) is dropped; patterns the last Shorts used go last; ties go to the pattern that kept more viewers.
 */
export function pickHook(cands: { hook: string; pattern: string; score: number }[], st: ReturnType<typeof hookPatternStats>, used: string[] = []) {
  const top = Math.max(...cands.map((c) => c.score));
  const bestPat = Math.max(0, ...Object.values(st.stats).filter((x) => x.n >= 3).map((x) => x.score));
  const weak = (p: string) => (st.stats[p]?.n ?? 0) >= 3 && st.stats[p]!.score < bestPat - 0.12;
  const pool = cands.filter((c) => c.score >= top - 0.6 && !weak(c.pattern) && /^[^0-9٠-٩*#]*$/.test(c.hook) && words(c.hook) >= 3 && words(c.hook) <= 14);
  const recent = [...st.recent, ...used];
  return pool.sort((a, b) => Number(recent.includes(a.pattern)) - Number(recent.includes(b.pattern)) || (st.stats[b.pattern]?.score ?? 0.5) - (st.stats[a.pattern]?.score ?? 0.5) || b.score - a.score)[0];
}

const firstSentence = (t: string) => (t.match(/^[^.!؟?…\n]+[.!؟?…]*/) ?? [t])[0]!.trim();
const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;

/** Openings that kept viewers (share still watching after the opening, views vs usual) and ones that lost them. */
export function hookEvidence(ctx: AgentContext, now = new Date()) {
  const perf = buildPerformance(ctx, allPosts(ctx), now).filter((s) => s.hook);
  const rows = perf.map((s) => {
    const kept = s.whereViewersLeft?.keptAfterOpening;
    const vs = s.results.length ? s.results.reduce((a, r) => a + r.vsPlatformUsual, 0) / s.results.length : 1;
    return { hook: s.hook!, keptAfterOpening: kept !== undefined ? `${Math.round(kept * 100)}%` : undefined, viewsVsUsual: Number(vs.toFixed(2)), sort: (kept ?? 0.5) + Math.log(vs) / 3 };
  }).sort((a, b) => b.sort - a.sort).map(({ sort: _, ...r }) => r);
  return { hooksThatKeptViewers: rows.slice(0, 5), hooksThatLostViewers: rows.length > 5 ? rows.slice(-4) : [] };
}

/** Best opening per Short; a Short the model can't handle keeps its hook. Never throws. */
export async function chooseHooks(ctx: AgentContext, shorts: { n: number; narration: string; title: string; trend?: string }[], videoId?: string): Promise<HookChoice[]> {
  if (!shorts.length) return [];
  const r = await ctx.providers.llm.generateJson({
    task: 'hooks.choose',
    tier: 'writing',
    system: 'You are the hook editor of "سر الموبايل" (Egyptian Arabic phone-secret Shorts). The FIRST SENTENCE decides if people keep watching. ' +
      'For EACH Short write 5 genuinely different opening sentences in natural spoken Egyptian Arabic (≤ 12 words, said in under 3 seconds), each using a different pattern: ' +
      '"shock-benefit" (موبايلك بيقدر يعمل كذا ومحدش قالك), "warning" (لو مش عامل كده… / بلاش تعمل كذا قبل ما تشوف ده), "nobody-tells" (الحاجة دي الشركات مش عايزاك تعرفها — only if true), ' +
      '"challenge" (أراهنك إنك متعرفش…), "result-first" (شوف موبايلك بيعمل إيه لما…), "question" (عارف إن…؟). ' +
      'Rules: start with the payoff, never with a greeting or "النهارده هقولك"; no codes, digits or menu paths in the hook (they come later); TRUE to the narration — promise only what the Short delivers; it must flow into the narration\'s second sentence. If a Short has `trend`, EVERY candidate must tie that trend (what Egypt is talking about now) to the tip — that is what makes it spread. ' +
      'Score each 0–10: stops the scroll in 1 second, clear personal benefit or fear of missing out, curiosity that only the end of the Short answers, natural Egyptian speech. ' +
      'Learn from hooksThatKeptViewers / hooksThatLostViewers (our real retention: keptAfterOpening = share still watching after the opening) patternStats (how each pattern kept viewers) and hookRules (rules the analyst learned from our view counts); keep inventing fresher variations of the patterns that work. best = the highest-scoring hook. ' +
      'bridge = ONE short sentence (≤ 10 words) said right after the hook that keeps any information of the replaced currentHook the rest needs (e.g. "فيه كود سري هيكشفلك ده في ثانية."), or "" if the second sentence already flows. JSON only.',
    prompt: JSON.stringify({ shorts: shorts.map((s) => ({ n: s.n, title: s.title, currentHook: firstSentence(s.narration), narration: s.narration, ...(s.trend ? { trend: s.trend } : {}) })), ...hookEvidence(ctx), patternStats: hookPatternStats(ctx).stats, hookRules: ctx.repos.knowledge.byCategory('lesson').map((k) => k.insight).filter((x) => /^Performance \((hook|retention)/.test(x)).slice(0, 6) }),
    schema: Choice,
    videoId,
    maxOutputTokens: 3000,
  }).catch(() => undefined);
  if (!r) return [];
  const data = r.data as z.infer<typeof Choice>;
  // Independent truth check: a hook that promises more than the Short shows (e.g. "someone listens to your
  // calls" for a call-FORWARDING code) breaks trust — such candidates are dropped before picking.
  const truth = await ctx.providers.llm.generateJson({
    task: 'hooks.truth',
    tier: 'light',
    system: 'You check opening lines of phone-secret Shorts against their narration. A candidate is FALSE if it claims or implies anything the narration does not support (a bigger threat, a different capability, a result the steps do not give, "all phones" when it is limited). ' +
      'Return, per Short, the indexes (0-based) of FALSE candidates, and whether the bridge is false. Be strict. JSON only.',
    prompt: JSON.stringify({ shorts: data.shorts.map((s) => ({ n: s.n, narration: shorts.find((x) => x.n === s.n)?.narration ?? '', candidates: s.candidates.map((c) => c.hook), bridge: s.bridge })) }),
    schema: z.object({ shorts: z.array(z.object({ n: z.number().int(), falseIdx: z.array(z.number().int()).default([]), bridgeFalse: z.boolean().default(false) })) }),
    videoId,
    maxOutputTokens: 800,
  }).catch(() => undefined);
  const out: HookChoice[] = [];
  const st = hookPatternStats(ctx);
  for (const s of data.shorts) {
    const orig = shorts.find((x) => x.n === s.n);
    const tv = (truth?.data as { shorts: { n: number; falseIdx: number[]; bridgeFalse: boolean }[] } | undefined)?.shorts.find((x) => x.n === s.n);
    if (!truth) continue; // can't check → keep the writer's own hook
    const honest = s.candidates.filter((_, i) => !tv?.falseIdx.includes(i));
    if (tv?.bridgeFalse) s.bridge = '';
    const chosen = pickHook(honest, st, out.map((x) => x.pattern ?? ''));
    if (!orig || !chosen) continue;
    const best = chosen.hook.trim();
    const bridge = s.bridge.trim() && !/[0-9٠-٩*#]/.test(s.bridge) && words(s.bridge) <= 12 ? s.bridge.trim() : '';
    out.push({ n: s.n, from: firstSentence(orig.narration), to: /[.!؟?…]$/.test(best) ? best : `${best}!`, ...(bridge ? { bridge: /[.!؟?…]$/.test(bridge) ? bridge : `${bridge}.` } : {}), pattern: chosen.pattern, candidates: s.candidates });
  }
  return out;
}

/** Puts the chosen hook in place of the narration's first sentence. */
export function applyHook(narration: string, hook: string, bridge = ''): string {
  const first = firstSentence(narration);
  return `${hook} ${bridge ? `${bridge} ` : ''}${narration.slice(first.length).trimStart()}`.trim();
}
