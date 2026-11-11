/**
 * Performance analyst ("محلل الأداء"): once a day, looks at every Short measured in the last 7 days on each
 * platform, finds the ones that got few views, works out WHY from the evidence (hook, title, topic, length,
 * how much people watched, hour, platform fit, caption) and turns it into concrete rules the writer and the
 * caption writer apply to the next Shorts. When there is too little data to be sure, it proposes small
 * experiments instead of guessing.
 */
import { z } from 'zod';
import type { AgentContext } from '../agents/base.ts';
import { allPosts, readKnowledge, type Post } from './learner.ts';

const AREAS = ['hook', 'title', 'topic', 'length', 'retention', 'visuals', 'timing', 'caption', 'platform', 'experiment'] as const;
const Analysis = z.object({
  diagnoses: z.array(z.object({ title: z.string(), platform: z.string(), cause: z.string(), evidence: z.string() })).max(8),
  actions: z.array(z.object({ area: z.enum(AREAS), platform: z.enum(['all', 'youtube', 'facebook', 'instagram']).default('all'), rule: z.string().min(10).max(300), why: z.string().max(300) })).max(5),
  summaryArabic: z.string().min(10).max(900),
});
export type AnalysisResult = z.infer<typeof Analysis>;

export interface ShortPerformance {
  title: string; family?: string | null; secretId?: string | null; hook?: string; words?: number; durationSec?: number;
  results: { platform: string; cairoHour: number; views: number; likes: number; shares?: number; saves?: number; watchedPercent?: number; vsPlatformUsual: number }[];
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : 0; };
const strip = (t?: string | null) => (t ?? '').replace(/\s*#Shorts$/, '').trim();

/** The facts the analyst reasons over: one row per Short, its numbers per platform and what it said. */
export function buildPerformance(ctx: AgentContext, posts: Post[], now: Date): ShortPerformance[] {
  const measured = posts.filter((p) => p.metrics.h24 && now.getTime() - new Date(p.publish_at).getTime() < 7 * 86_400_000);
  const usual: Record<string, number> = {};
  for (const pl of ['youtube', 'facebook', 'instagram']) usual[pl] = median(posts.filter((p) => p.platform === pl && p.metrics.h24).slice(-14).map((p) => p.metrics.h24!.views));
  const by = new Map<string, ShortPerformance>();
  for (const p of measured) {
    const key = strip(p.title);
    if (!by.has(key)) by.set(key, { title: key, family: p.family, secretId: p.secret_id, ...whatItSaid(ctx, p) });
    const m = (p.metrics.h72 ?? p.metrics.h24)! as Post['metrics']['h24'] & { saves?: number };
    by.get(key)!.results.push({
      platform: p.platform, cairoHour: (new Date(p.publish_at).getUTCHours() + 2) % 24, views: m!.views, likes: m!.likes ?? 0,
      shares: m!.shares, saves: m!.saves, watchedPercent: p.metrics.h72?.avgPercentViewed !== undefined ? Math.round(p.metrics.h72.avgPercentViewed * 100) : undefined,
      vsPlatformUsual: Number(((m!.views + 1) / (usual[p.platform]! + 1)).toFixed(2)),
    });
  }
  return [...by.values()].map((s) => ({ ...s, results: s.results ?? [] }));
}

/** Everything the Short said (for answering comments only from what it really says). */
export function postNarration(ctx: AgentContext, p: Post): string | undefined {
  if (!p.video_id) return undefined;
  const topics = ctx.repos.artifacts.latest<{ topics?: { title: string; subject: string }[] }>(p.video_id, 'calendar_entry')?.data.topics ?? [];
  const i = topics.findIndex((t) => t.subject === p.secret_id || strip(t.title) === strip(p.title));
  return ctx.repos.artifacts.latest<{ scenes: { n: number; voiceover: string }[] }>(p.video_id, 'script')?.data.scenes.find((s) => s.n === i + 1)?.voiceover;
}

/** The Short's opening sentence, length and duration, from the production that made it. */
function whatItSaid(ctx: AgentContext, p: Post): Omit<ShortPerformance, 'title' | 'family' | 'secretId'> {
  const out: Omit<ShortPerformance, 'title' | 'family' | 'secretId'> = { results: [] };
  if (!p.video_id) return out;
  const topics = ctx.repos.artifacts.latest<{ topics?: { title: string; subject: string }[] }>(p.video_id, 'calendar_entry')?.data.topics ?? [];
  const i = topics.findIndex((t) => t.subject === p.secret_id || strip(t.title) === strip(p.title));
  const scene = ctx.repos.artifacts.latest<{ scenes: { n: number; voiceover: string }[] }>(p.video_id, 'script')?.data.scenes.find((s) => s.n === i + 1);
  if (scene) {
    out.hook = (scene.voiceover.match(/[^.!؟?…]+[.!؟?…]+/) ?? [scene.voiceover])[0]!.trim().slice(0, 200);
    out.words = scene.voiceover.split(/\s+/).filter(Boolean).length;
  }
  const short = ctx.repos.artifacts.latest<{ shorts?: { scenes?: number[]; durationSec: number }[] }>(p.video_id, 'render')?.data.shorts?.find((s) => s.scenes?.includes(i + 1));
  if (short) out.durationSec = Math.round(short.durationSec);
  return out;
}

/** Lessons that are really outages (busy servers, quotas, timeouts) teach the writer nothing. */
export function isInfraProblem(text: string): boolean {
  return /HTTP (429|5\d\d)|quota|RESOURCE_EXHAUSTED|high demand|overloaded|timed? ?out|timeout|network error|ECONN|fetch failed|no approval request/i.test(text);
}

/** Runs at most once a day; returns Arabic lines for the owner's report. */
export async function analyzePerformance(ctx: AgentContext, now: Date): Promise<string[]> {
  const day = now.toISOString().slice(0, 10);
  if (readKnowledge(ctx, 'analysis_day=') === day) return [];
  const shorts = buildPerformance(ctx, allPosts(ctx), now).filter((s) => s.results.length);
  if (shorts.length < 1) return [];
  // What viewers wrote in the last 7 days: their questions, confusion and requests are evidence too.
  const viewerComments = ctx.repos.artifacts.listKind<{ heard?: { platform: string; title: string; text: string }[] }>('comment_replies')
    .filter((a) => now.getTime() - new Date(a.created_at).getTime() < 7 * 86_400_000).flatMap((a) => a.data.heard ?? []).slice(-40);
  const previous = ctx.repos.knowledge.byCategory('lesson').filter((k) => k.insight.startsWith('Performance')).slice(0, 6).map((k) => k.insight);
  const r = await ctx.providers.llm.generateJson({
    task: 'analytics.diagnose',
    tier: 'writing',
    system: 'You are the performance analyst of "سر الموبايل", an Egyptian Arabic channel of 30–45 s phone/app secret Shorts posted on YouTube Shorts, Facebook Reels and Instagram Reels. ' +
      'Goal: much higher views. For every Short and platform you get views, likes, shares, saves, % watched, the Cairo hour, and "vsPlatformUsual" (1 = normal for that platform, 0.3 = a third). ' +
      'Find the Shorts that under-performed and explain WHY from the evidence, comparing them with the ones that did better: weak first sentence (does it promise a clear personal benefit within 2 seconds?), unclear/low-curiosity title, a topic few people search for, too long (people left: low % watched), wrong hour, platform mismatch (e.g. good on Instagram but dead on Facebook → Facebook needs a different caption/approach), weak caption. ' +
      'Then give at most 5 concrete, testable rules for the NEXT Shorts (English, imperative, specific — e.g. "Open with the result in ≤ 6 words: \'موبايلك هيقفل لوحده لو…\'", not "make better hooks"). Only rules the team can apply: hook, title, topic choice, length, retention, visuals, timing, caption (per platform), platform. ' +
      'Read viewerComments too: what people ask, what confused them, what they want next, complaints (too fast, wrong phone, didn\'t work) — turn real patterns into rules (e.g. say which phones/versions it works on, slow down the steps, cover the requested apps). ' +
      'If the numbers are too few to conclude, say so honestly and propose one small experiment (area "experiment") instead of a confident rule. Do not repeat rules already in previousRules unless the new data changes them. ' +
      'summaryArabic: 3–6 short lines in Egyptian Arabic for the owner: what is weak, the likely reason, and what the team will change. JSON only.',
    prompt: JSON.stringify({ shorts, viewerComments, previousRules: previous }),
    schema: Analysis,
    maxOutputTokens: 3000,
  }).catch((err: Error) => { if (isInfraProblem(err.message)) return undefined; throw err; });
  if (!r) return [];
  const a = r.data as AnalysisResult;
  const n = shorts.reduce((x, s) => x + s.results.length, 0);
  for (const act of a.actions) {
    const insight = `Performance (${act.area}${act.platform !== 'all' ? `/${act.platform}` : ''}): ${act.rule}`;
    if (!ctx.repos.knowledge.byCategory('lesson').some((k) => k.insight === insight)) {
      ctx.repos.knowledge.add({ category: 'lesson', insight, evidence: act.why, confidence: Date.now() / 1e13, sampleSize: n });
    }
  }
  ctx.repos.knowledge.add({ category: 'learning', insight: `analysis_day=${day}`, evidence: a.diagnoses.map((d) => `${d.title} (${d.platform}): ${d.cause}`).join(' | ').slice(0, 900), confidence: Date.now() / 1e13, sampleSize: n });
  return [`🔎 محلل الأداء:\n${a.summaryArabic.trim()}`];
}

/** Rules for the writer: the analyst's newest findings first, then other lessons; never outage noise. */
export function writerLessons(ctx: AgentContext, max = 8): string[] {
  const all = ctx.repos.knowledge.byCategory('lesson').map((k) => k.insight).filter((x) => !isInfraProblem(x));
  const perf = all.filter((x) => x.startsWith('Performance') && !/^Performance \((caption|timing)/.test(x));
  return [...perf.slice(0, 5), ...all.filter((x) => !x.startsWith('Performance')).slice(0, Math.max(0, max - Math.min(5, perf.length)))];
}

/** Caption rules the analyst found for one platform (or all). */
export function captionLessons(ctx: AgentContext, platform: 'facebook' | 'instagram'): string[] {
  return ctx.repos.knowledge.byCategory('lesson').map((k) => k.insight)
    .filter((x) => x.startsWith('Performance (caption') || x.startsWith(`Performance (platform/${platform})`))
    .filter((x) => !/\/(youtube|facebook|instagram)\)/.test(x) || x.includes(`/${platform})`))
    .slice(0, 4);
}
