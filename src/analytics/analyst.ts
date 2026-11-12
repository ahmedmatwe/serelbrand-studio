/**
 * Performance analyst ("محلل الأداء"): once a day, looks at every Short measured in the last 7 days on each
 * platform, finds the ones that got few views, works out WHY from the evidence (hook, title, topic, length,
 * how much people watched, hour, platform fit, caption) and turns it into concrete rules the writer and the
 * caption writer apply to the next Shorts. When there is too little data to be sure, it proposes small
 * experiments instead of guessing.
 */
import { z } from 'zod';
import type { AgentContext } from '../agents/base.ts';
import { allPosts, learnedMaxShot, readKnowledge, type Post } from './learner.ts';
import { motionShare, motionStyle, stepStyle } from '../media/motion.ts';
import { GENES } from '../../motion/types.ts';

const AREAS = ['hook', 'title', 'topic', 'trend', 'length', 'retention', 'visuals', 'shots', 'editing', 'motion', 'timing', 'caption', 'platform', 'experiment'] as const;
const Analysis = z.object({
  diagnoses: z.array(z.object({ title: z.string(), platform: z.string(), cause: z.string(), evidence: z.string() })).max(8),
  actions: z.array(z.object({ area: z.enum(AREAS), platform: z.enum(['all', 'youtube', 'facebook', 'instagram']).default('all'), rule: z.string().min(10).max(300), why: z.string().max(300) })).max(5),
  summaryArabic: z.string().min(10).max(900),
  /** Editing settings the analyst may tune (small steps): how long one shot may stay on screen. */
  settings: z.object({
    maxShotSec: z.number().min(3).max(6).optional(),
    /** Share of Shorts drawn as motion graphics (rest = stock footage). */
    motionShare: z.number().min(0).max(1).optional(),
    /** Motion-graphics look. */
    motion: z.object({ variants: z.object({ theme: z.enum(GENES.theme), bg: z.enum(GENES.bg), caption: z.enum(GENES.caption), transition: z.enum(GENES.transition), hook: z.enum(GENES.hook), headline: z.enum(GENES.headline), phone: z.enum(GENES.phone) }).partial().optional(), camera: z.number().min(0).max(1).optional(), transition: z.enum(GENES.transition).optional(), particles: z.boolean().optional(), captionSize: z.number().min(52).max(80).optional(), flash: z.number().min(0).max(0.4).optional() }).optional(),
  }).default({}),
});
export type AnalysisResult = z.infer<typeof Analysis>;

export interface ShortPerformance {
  title: string; family?: string | null; secretId?: string | null; hook?: string; words?: number; durationSec?: number;
  /** motion = drawn motion graphics, stock = stock footage. */
  look?: 'motion' | 'stock';
  /** The Egyptian trend this Short rode, if any. */
  trend?: string;
  /** Motion design genes used, e.g. "motion hook/slam [stagger/tilt]". */
  design?: string;
  /** The editing critic's scores before publishing (0–10) and its notes. */
  editReview?: { hook: number; visualMatch: number; pacing: number; captions: number; notes: string };
  /** YouTube: share still watching after the opening, and the second most people left + what was on screen/said then. */
  whereViewersLeft?: { keptAfterOpening?: number; second?: number; showing?: string; said?: string };
  shotLog?: { start: number; duration: number; said: string; showing: string }[];
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
    const h72 = p.metrics.h72;
    if (p.platform === 'youtube' && h72 && (h72.kept3s !== undefined || h72.dropAt !== undefined)) {
      const s = by.get(key)!;
      const sec = h72.dropAt !== undefined && s.durationSec ? Math.round(h72.dropAt * s.durationSec) : undefined;
      const shot = sec !== undefined ? s.shotLog?.find((x) => sec >= x.start && sec < x.start + x.duration) : undefined;
      s.whereViewersLeft = { keptAfterOpening: h72.kept3s, second: sec, showing: shot?.showing, said: shot?.said };
    }
  }
  return [...by.values()].map(({ shotLog: _, ...s }) => ({ ...s, results: s.results ?? [] }));
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
  const topics = ctx.repos.artifacts.latest<{ topics?: { title: string; subject: string; angle?: string }[] }>(p.video_id, 'calendar_entry')?.data.topics ?? [];
  const i = topics.findIndex((t) => t.subject === p.secret_id || strip(t.title) === strip(p.title));
  const tr = topics[i]?.angle?.match(/^\[TREND «([^»]+)»/)?.[1];
  if (tr) out.trend = tr;
  const scene = ctx.repos.artifacts.latest<{ scenes: { n: number; voiceover: string }[] }>(p.video_id, 'script')?.data.scenes.find((s) => s.n === i + 1);
  if (scene) {
    out.hook = (scene.voiceover.match(/[^.!؟?…]+[.!؟?…]+/) ?? [scene.voiceover])[0]!.trim().slice(0, 200);
    out.words = scene.voiceover.split(/\s+/).filter(Boolean).length;
  }
  const short = ctx.repos.artifacts.latest<{ shorts?: { scenes?: number[]; durationSec: number; shotLog?: ShortPerformance['shotLog']; look?: 'motion' | 'stock' }[] }>(p.video_id, 'render')?.data.shorts?.find((s) => s.scenes?.includes(i + 1));
  if (short) { out.durationSec = Math.round(short.durationSec); out.shotLog = short.shotLog; out.look = short.look ?? 'stock'; if (out.look === 'motion') out.design = short.shotLog?.[0]?.showing.match(/\{[^}]*\}/)?.[0]; }
  const rev = ctx.repos.artifacts.listKind<{ n: number; hook: number; visualMatch: number; pacing: number; captions: number; notes: string }>('edit_review').filter((a) => a.video_id === p.video_id && a.data.n === i + 1).at(-1)?.data;
  if (rev) out.editReview = { hook: rev.hook, visualMatch: rev.visualMatch, pacing: rev.pacing, captions: rev.captions, notes: rev.notes };
  return out;
}

/** Lessons that are really outages (busy servers, quotas, timeouts) teach the writer nothing. */
export function isInfraProblem(text: string): boolean {
  return /HTTP (429|5\d\d)|quota|RESOURCE_EXHAUSTED|high demand|overloaded|timed? ?out|timeout|network error|ECONN|fetch failed|no approval request/i.test(text);
}

/**
 * Runs as soon as there is new evidence (new measurements, retention curves, viewer comments or editing reviews),
 * at most every 3 hours; returns Arabic lines for the owner.
 */
export async function analyzePerformance(ctx: AgentContext, now: Date): Promise<string[]> {
  const day = now.toISOString().slice(0, 10);
  const shorts = buildPerformance(ctx, allPosts(ctx), now).filter((s) => s.results.length);
  if (shorts.length < 1) return [];
  const evidence = JSON.stringify([shorts.map((s) => [s.title, s.results.map((r) => r.views), s.whereViewersLeft, s.editReview?.hook]), ctx.repos.artifacts.listKind('comment_replies').length]);
  const fingerprint = String(evidence.length) + ':' + [...evidence].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const last = readKnowledge(ctx, 'analysis_state=')?.split('|');
  if (last && (last[0] === fingerprint || now.getTime() - Date.parse(last[1] ?? '') < 3 * 3_600_000)) return [];
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
      'Each Short may carry editReview (the editing critic\'s scores before publishing) and whereViewersLeft (YouTube: share still watching after the opening, and the second most people left with what was on screen and being said then) — use them to find editing/shot problems (areas "shots", "editing", "visuals") and set settings.maxShotSec (3–6 s per shot; lower = faster cuts) only when the evidence points to pacing. ' +
      'Each Short has look = "motion" (drawn motion graphics) or "stock" (stock footage). Compare them on vsPlatformUsual, watchedPercent and whereViewersLeft; set settings.motionShare (0–1, share of Shorts in motion) toward the better look only when the difference is clear; ' +
      'for motion Shorts, use editReview + whereViewersLeft (showing = "motion <scene>: <headline>") to improve the drawn look: rules in area "motion" (e.g. which scene types hold viewers, shorter headlines, faster opening) and settings.motion (camera 0–1, transition whip|zoom|fade, particles, captionSize 52–80, flash 0–0.4) in small steps. ' +
      'Motion Shorts carry their design genes in "design" (theme, background, caption style, transition, hook, headline, phone). The team uses only strong versions and varies them so videos never look alike; when one version clearly keeps more viewers or gets more views, set settings.motion.variants to it (it gets a bonus, it is not forced on every video). ' +
      'Shorts with "trend" rode a trend in Egypt: compare them with normal Shorts and write rules in area "trend" (which kinds of trends and bridges spread, how fast it must be out, how the hook should tie in) — the trend scout follows them. ' +
      'Read viewerComments too: what people ask, what confused them, what they want next, complaints (too fast, wrong phone, didn\'t work) — turn real patterns into rules (e.g. say which phones/versions it works on, slow down the steps, cover the requested apps). ' +
      'If the numbers are too few to conclude, say so honestly and propose one small experiment (area "experiment") instead of a confident rule. Do not repeat rules already in previousRules unless the new data changes them. ' +
      'summaryArabic: 3–6 short lines in Egyptian Arabic for the owner: what is weak, the likely reason, and what the team will change. JSON only.',
    prompt: JSON.stringify({ shorts, viewerComments, previousRules: previous }),
    schema: Analysis,
    maxOutputTokens: 7000,
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
  // Settings move at most once a day each: the numbers of a few hours are mostly noise.
  const changedToday = (prefix: string) => {
    const k = ctx.repos.knowledge.byCategory('learning').find((x) => x.insight.startsWith(prefix));
    return Boolean(k && now.getTime() - k.confidence * 1e13 < 22 * 3_600_000);
  };
  // Editing pace: one small step at a time (±0.5 s), only within 3–6 s.
  const cur = learnedMaxShot(ctx);
  const want = changedToday('shot_max_sec=') ? undefined : a.settings?.maxShotSec;
  let paceLine = '';
  if (want !== undefined && Math.abs(want - cur) >= 0.25) {
    const next = Math.min(6, Math.max(3, cur + Math.sign(want - cur) * Math.min(0.5, Math.abs(want - cur))));
    ctx.repos.knowledge.add({ category: 'learning', insight: `shot_max_sec=${next}`, evidence: 'analyst: where viewers leave / editing critic', confidence: Date.now() / 1e13, sampleSize: n });
    paceLine = `\n✂️ المونتاج: أقصى مدة للقطة بقت ${next} ثانية (كانت ${cur})`;
  }
  // Motion graphics: share (±0.2 per analysis) and look (small steps).
  if (a.settings?.motionShare !== undefined && !changedToday('motion_share=')) {
    const cur2 = motionShare(ctx);
    const next2 = Number(Math.min(1, Math.max(0, cur2 + Math.sign(a.settings.motionShare - cur2) * Math.min(0.2, Math.abs(a.settings.motionShare - cur2)))).toFixed(2));
    if (next2 !== cur2) { ctx.repos.knowledge.add({ category: 'learning', insight: `motion_share=${next2}`, evidence: 'analyst: motion vs stock', confidence: Date.now() / 1e13, sampleSize: n }); paceLine += `\n🎨 الموشن جرافيك: ${Math.round(next2 * 100)}% من الفيديوهات (كانت ${Math.round(cur2 * 100)}%)`; }
  }
  if (a.settings?.motion && !changedToday('motion_style=')) {
    const next3 = stepStyle(motionStyle(ctx), a.settings.motion);
    if (next3) { ctx.repos.knowledge.add({ category: 'learning', insight: `motion_style=${JSON.stringify(next3)}`, evidence: 'analyst: motion look', confidence: Date.now() / 1e13, sampleSize: n }); paceLine += '\n🎨 شكل الموشن اتظبط حسب الأرقام وملاحظات الناقد'; }
  }
  ctx.repos.knowledge.add({ category: 'learning', insight: `analysis_state=${fingerprint}|${now.toISOString()}`, evidence: '', confidence: Date.now() / 1e13, sampleSize: n });
  ctx.repos.knowledge.add({ category: 'learning', insight: `analysis_day=${day}`, evidence: a.diagnoses.map((d) => `${d.title} (${d.platform}): ${d.cause}`).join(' | ').slice(0, 900), confidence: Date.now() / 1e13, sampleSize: n });
  return [`🔎 محلل الأداء:\n${a.summaryArabic.trim()}${paceLine}`];
}

/** Rules for the writer: the analyst's newest findings first, then other lessons; never outage noise. */
export function writerLessons(ctx: AgentContext, max = 8): string[] {
  const all = ctx.repos.knowledge.byCategory('lesson').map((k) => k.insight).filter((x) => !isInfraProblem(x));
  const perf = all.filter((x) => x.startsWith('Performance') && !/^Performance \((caption|timing|shots|editing|visuals|motion)/.test(x));
  return [...perf.slice(0, 5), ...all.filter((x) => !x.startsWith('Performance')).slice(0, Math.max(0, max - Math.min(5, perf.length)))];
}

/** Caption rules the analyst found for one platform (or all). */
export function captionLessons(ctx: AgentContext, platform: 'facebook' | 'instagram'): string[] {
  return ctx.repos.knowledge.byCategory('lesson').map((k) => k.insight)
    .filter((x) => x.startsWith('Performance (caption') || x.startsWith(`Performance (platform/${platform})`))
    .filter((x) => !/\/(youtube|facebook|instagram)\)/.test(x) || x.includes(`/${platform})`))
    .slice(0, 4);
}
