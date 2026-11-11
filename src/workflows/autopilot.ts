/**
 * Autopilot: one idempotent cycle, safe to run every couple of hours (launchd).
 *  1. Upload videos the human already approved (private).
 *  2. Capture analytics checkpoints that are due, then diagnose.
 *  3. On a production day (per the content calendar), produce the next video up to the approval request.
 *  4. Write the daily report and notify the human when something needs them.
 * It never approves anything by itself and never publishes publicly.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentContext } from '../agents/base.ts';
import type { StrategyOutput } from '../agents/content-strategy.ts';
import type { TrendResearchOutput } from '../agents/trend-research.ts';
import type { CalendarEntry, FactCheckReport } from '../agents/schemas.ts';
import { z } from 'zod';
import type { PublishLog } from '../publishing/publisher.ts';
import { postPublish, produceVideo, publish } from './orchestrator.ts';
import { approve } from '../publishing/approval.ts';
import { learnPublishSlots } from '../analytics/optimization.ts';
import type { PrePublicationReport } from '../reports/prepublication.ts';
import type { RenderOutput } from '../media/renderer.ts';
import { qcBlockers, qualityChecklist } from '../reports/qc.ts';
import { quotaResetSeconds } from '../providers/tts/gemini-tts.ts';
import { writePackage } from '../reports/package.ts';
import { steps } from './steps.ts';
import { answerComments, repliesMessage } from '../publishing/comments.ts';
import { analyzePerformance, isInfraProblem } from '../analytics/analyst.ts';
import { dailyReport, learnedFamilyWeights, registerPost, runLearning } from '../analytics/learner.ts';
import { cairoTime, telegramFromEnv, type Telegram } from '../publishing/telegram.ts';
import { syncBot, type LiveStats } from '../publishing/bot-sync.ts';
import { readPosted, socialFromEnv } from '../publishing/social.ts';
import { family, loadPhoneLibrary, pickPhoneSecrets } from '../agents/niche/phone-library.ts';

export interface CycleOptions {
  now?: Date;
  /** Skip production (e.g. analytics-only runs). */
  productionBudgetMs?: number; /** With force: which format to make. */ forceFormat?: 'long' | 'short'; produce?: boolean; /** Produce even if today's video already exists (manual test run). */ force?: boolean;
  notify?: (title: string, body: string) => void;
  renderSize?: 'full' | 'preview';
}

export interface CycleReport {
  startedAt: string;
  published: string[];
  analyticsUpdated: string[];
  commentReplies?: number;
  produced: { videoId: string; title: string; recommendation: string; claimsToVerify: number; autoApproved?: boolean; autoApproveBlockedBy?: string[]; publishAt?: string } | null;
  skippedProductionReason?: string;
  pendingApprovals: number;
  needsFactReview: { videoId: string; title: string; claims: number }[];
  errors: string[];
  /** Videos blocked in this run before a later attempt (if any) succeeded. */
  blockedAttempts: { title: string; reason: string }[];
  /** What the learner measured, decided or flagged this cycle (Arabic). */
  learning?: string[];
}

const LOCK_STALE_MS = 3 * 3600_000;

/**
 * Every condition must hold for a video to be approved without a human.
 * Returns the list of unmet conditions (empty = OK to auto-approve).
 */
export function autoApproveBlockers(r: PrePublicationReport, render: RenderOutput | undefined, minQuality: number): string[] {
  const why: string[] = [];
  if (r.hardBlockers.length) why.push(...r.hardBlockers);
  if (r.complianceScore < 90) why.push(`compliance ${r.complianceScore} < 90`);
  if (r.qualityScore < minQuality) why.push(`quality ${r.qualityScore} < ${minQuality}`);
  if (r.factCheckStatus !== 'verified') why.push(`facts ${r.factCheckStatus}`);
  if (r.copyrightStatus !== 'clear') why.push(`copyright ${r.copyrightStatus}`);
  if (r.monetizationRisk === 'high') why.push('monetization risk high');
  for (const w of r.warnings) if (/^(Quality|Compliance)/.test(w)) why.push(w);
  if (!render) why.push('no render');
  else if (render.measurements.audioScore <= 0) why.push('silent/invalid audio');
  return why;
}

/** Prevents two cycles from overlapping (launchd + a manual run). */
export function acquireLock(path: string, now = Date.now()): boolean {
  if (existsSync(path) && now - statSync(path).mtimeMs < LOCK_STALE_MS) return false;
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, String(process.pid));
  return true;
}

/** In GitHub Actions, notifications are collected in data/notify.md and posted to a GitHub issue (→ email). */
export const cloudNotify = (title: string, body: string) => {
  mkdirSync(resolve(process.cwd(), 'data'), { recursive: true });
  const p = resolve(process.cwd(), 'data/notify.md');
  writeFileSync(p, (existsSync(p) ? readFileSync(p, 'utf8') : '') + `- **${title}** — ${body}\n`);
};

export const macNotify = (title: string, body: string) => {
  if (process.env.GITHUB_ACTIONS) return cloudNotify(title, body);
  if (process.platform !== 'darwin') return;
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  execFile('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}" sound name "Glass"`], () => {});
};

const day = (d: Date) => d.toISOString().slice(0, 10);

const STOP = new Set(['قصة', 'حكاية', 'ازاي', 'إزاي', 'ليه', 'لماذا', 'كيف', 'شركة', 'شركات', 'اكبر', 'أكبر', 'العالم', 'عالم', 'اللي', 'التي', 'الذي', 'عن', 'من', 'إلى', 'الى', 'على', 'في', 'ورا', 'سر', 'أسرار', 'اسرار', 'short', 'shorts']);
const words = (t: string) => new Set((t.toLowerCase().replace(/[\u064b-\u065f]/g, '').match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !STOP.has(w)).map((w) => w.replace(/^(وال|بال|لل|ال)/, '')).filter((w) => w.length >= 3 && !STOP.has(w)));
/** Same topic = at least 2 shared distinctive words (e.g. company + event), or ≥ 60% overlap. */
export function isDuplicateTopic(title: string, produced: Iterable<string>): boolean {
  const a = words(title);
  for (const p of produced) {
    const b = words(p);
    const inter = [...a].filter((w) => b.has(w)).length;
    if (inter >= 2 || (inter >= 1 && inter / Math.max(1, Math.min(a.size, b.size)) >= 0.6)) return true;
  }
  return false;
}

/**
 * Today's plan: the long video scheduled for today (it brings its own 3 Shorts); otherwise a Shorts pack
 * (3 standalone Shorts) built on today's Shorts theme. Never more than one production per day.
 */
export function todaysPlan(strategy: StrategyOutput | undefined, producedTitles: Set<string>, now: Date) {
  if (!strategy) return undefined;
  const today = day(now);
  const fresh = (c: { title: string }) => !producedTitles.has(c.title) && !isDuplicateTopic(c.title.replace(/^Short:\s*/, ''), producedTitles);
  const long = strategy.calendar.find((c) => c.format === 'long' && c.date === today && fresh(c));
  if (long) return long;
  const short = strategy.calendar.find((c) => c.format === 'short' && c.date === today && fresh(c));
  if (short) return short;
  const missed = strategy.calendar.find((c) => c.format === 'long' && c.date < today && fresh(c));
  if (missed) return missed;
  // Today's topic was used (e.g. blocked → retry): pull the next upcoming topic forward, same format as today.
  const todayFormat = strategy.calendar.find((c) => c.date === today)?.format;
  if (!todayFormat) return undefined; // nothing planned for today (e.g. before the calendar starts)
  const upcoming = strategy.calendar.filter((c) => c.date > today && fresh(c)).sort((a, b) => a.date.localeCompare(b.date));
  return upcoming.find((c) => c.format === todayFormat) ?? upcoming[0];
}

/** The long video due today (or a missed one), if any. */
export function longPlan(strategy: StrategyOutput | undefined, producedTitles: Set<string>, now: Date) {
  if (!strategy) return undefined;
  const today = day(now);
  const fresh = (c: { title: string }) => !producedTitles.has(c.title) && !isDuplicateTopic(c.title, producedTitles);
  return strategy.calendar.find((c) => c.format === 'long' && c.date === today && fresh(c))
    ?? strategy.calendar.find((c) => c.format === 'long' && c.date < today && fresh(c));
}

const PackLLM = z.object({ topics: z.array(z.object({
  title: z.string().min(5), subject: z.string().min(2), angle: z.string(),
  kind: z.enum(['idea', 'story', 'code', 'feature', 'trick']).default('idea'),
  /** Official page that documents it (support.apple.com, support.google.com, samsung.com…), when there is one. */
  sourceUrl: z.string().default(''),
})).min(3) });
export type PackTopic = z.infer<typeof PackLLM>['topics'][number];

const BUSINESS_PACK_PROMPT = 'You plan VIRAL, USEFUL YouTube Shorts for an Arabic business channel (audience 18–34 in Egypt and the Gulf who want to earn more, start a project or grow at work). ' +
  'Propose 6 topics. Each Short reveals ONE secret, idea or little-known piece of business knowledge people love to discover and share, and that the viewer can USE in their own work or small project. Mix two kinds: ' +
  '(a) kind "idea": a well-documented business principle, psychological trick or rule (e.g. charm pricing 9.99, the decoy effect, the 80/20 rule, scarcity marketing, anchoring, loss aversion, the Pygmalion effect); ' +
  '(b) kind "story": a real documented company or founder story that proves a lesson (a decision that made millions, a mistake that destroyed a giant). At least 2 of the 3 should be "idea". ' +
  'Everything must be stated on the English Wikipedia article named in subject (its exact title). Each topic must be about a DIFFERENT idea. Avoid vague strategy talk. ' +
  'Title in simple Arabic (the channel dialect), 5–10 words, framed as a secret or idea. angle = the concrete fact + how the viewer can apply it. Never reuse a topic from `avoid`. JSON only.';

/** Phone secrets: hidden codes, hidden features and tricks people instantly try and share. */
const PHONE_PACK_PROMPT = 'You plan VIRAL YouTube Shorts for an Egyptian Arabic channel about SECRETS OF YOUR PHONE (audience 16–35 in Egypt and the Arab world, everyday iPhone and Android users). ' +
  'Propose 6 topics. Each Short reveals ONE hidden code, hidden feature or trick that most people do not know, that the viewer can try on their own phone in under a minute, and that makes them say "مكنتش أعرف!" and send it to a friend. Mix kinds: ' +
  'kind "code": a real dial code (e.g. *#06# shows the IMEI, *#*#4636#*#* opens Android testing info, *#0*# Samsung test menu, *3001#12345#* iPhone field test); ' +
  'kind "feature": a hidden setting (e.g. iPhone Back Tap, Android Developer options, Live Text, Guided Access, Find My offline, Wi-Fi password QR sharing, one-handed mode); ' +
  'kind "trick": a quick everyday trick (e.g. shake to undo, trackpad keyboard by holding space, scan documents in Notes). ' +
  'HARD SAFETY RULES: never codes or steps that erase, reset, unlock, root, change carrier settings, spy on others or bypass security; never anything that could damage the phone or lose data; it must work on current phones — say exactly which (iPhone / Android / Samsung) and where it may differ. ' +
  'subject = the English Wikipedia article title that documents it if one exists (e.g. "International Mobile Equipment Identity", "Unstructured Supplementary Service Data"), else the feature name; sourceUrl = the official support page (https://support.apple.com/…, https://support.google.com/…, https://www.samsung.com/…) that documents it, or "" if none. ' +
  'Title in Egyptian Arabic, 4–9 words, curiosity first, e.g. "كود لو كتبته في موبايلك هيكشفلك سر", "ميزة مخفية في الآيفون محدش يعرفها", "زرار سري ورا موبايلك". Each topic DIFFERENT; never reuse one from `avoid`. angle = exactly what the viewer does (the code or the settings path) and what they will see. JSON only.';

/** Three DIFFERENT, clear, specific Shorts topics, never repeating past titles, each with a real source. */
export async function planShortsPack(ctx: AgentContext, niche: string, avoid: string[]) {
  const phone = /phone|mobile|موبايل/i.test(niche);
  // Phone secrets: only reviewed entries from the approved library (never an AI-invented code).
  const lib = phone ? loadPhoneLibrary(ctx.config.rootDir) : undefined;
  if (lib) {
    // A secret counts as used only if its video was really made: productions that crashed (quota, network)
    // give their secrets back to the library.
    const crashed = new Set(ctx.repos.artifacts.listKind<{ blockers: string[] }>('auto_blocked').filter((a) => a.data.blockers.some((b) => b.startsWith('production failed'))).map((a) => a.video_id));
    const used = new Set(ctx.repos.artifacts.listKind<{ topics?: { subject: string }[] }>('calendar_entry').filter((a) => !crashed.has(a.video_id)).flatMap((a) => (a.data.topics ?? []).map((t) => t.subject)));
    const picks = pickPhoneSecrets(lib, used, 3, learnedFamilyWeights(ctx));
    if (picks.length === 3) return picks.map((x): PackTopic => ({ title: x.title, subject: x.id, angle: `${x.steps.join(' ← ')} → ${x.result}`, kind: x.kind, sourceUrl: lib.sources[x.source] ?? '' }));
    ctx.logger.child('autopilot').warn('phone-secrets library used up — add reviewed entries to config/phone-secrets.json', { left: picks.length });
    // Out of reviewed entries: fall through to AI-proposed topics (still need a real source and the full gates).
  }
  const r = await ctx.providers.llm.generateJson({
    task: 'shorts.topics',
    tier: 'light',
    system: phone ? PHONE_PACK_PROMPT : BUSINESS_PACK_PROMPT,
    prompt: JSON.stringify({ niche, dialect: ctx.config.channel.dialect, avoid: avoid.slice(-150) }),
    schema: PackLLM,
    maxOutputTokens: 3000,
  }).catch(() => undefined);
  const seen = new Set<string>();
  const picked: PackTopic[] = [];
  for (const t of r?.data.topics ?? []) {
    const key = t.subject.toLowerCase();
    if (seen.has(key) || isDuplicateTopic(t.title, new Set(avoid))) continue;
    // Only topics we can actually research: a Short written without sources drifts into vague, off-topic talk.
    if (ctx.providers.web.name !== 'mock-web') {
      const official = t.sourceUrl.startsWith('https://') ? await ctx.providers.web.fetchText(t.sourceUrl).catch(() => undefined) : undefined;
      if (!official || official.text.length < 600) {
        t.sourceUrl = '';
        const found = await ctx.providers.web.wikipedia(t.subject, 'en', 1).catch(() => []);
        if (!found.length || found[0]!.text.length < 1500) continue;
      }
    }
    seen.add(key);
    picked.push(t);
    if (picked.length === 3) break;
  }
  return picked;
}

export async function runCycle(ctx: AgentContext, o: CycleOptions = {}): Promise<CycleReport> {
  const now = o.now ?? new Date();
  const tg = o.notify ? undefined : telegramFromEnv();
  const sent: string[] = [];
  const baseNotify = o.notify ?? macNotify;
  const notify = (title: string, body: string) => { sent.push(`🔔 ${title}\n${body}`); baseNotify(title, body); };
  const rep: CycleReport = { startedAt: now.toISOString(), published: [], analyticsUpdated: [], produced: null, pendingApprovals: 0, needsFactReview: [], errors: [], blockedAttempts: [] };
  const log = ctx.logger.child('autopilot');

  // 1) Approved → upload (private).
  for (const v of ctx.repos.videos.list('approved')) {
    const r = await publish(ctx, v.id);
    if (r.status === 'succeeded') rep.published.push(v.id);
    else rep.errors.push(`publish ${v.id}: ${r.error}`);
  }

  // 2) Analytics for uploaded videos, by hours since upload.
  // Videos removed from the channel (status 'deleted') are never queried again.
  for (const v of ctx.repos.videos.list().filter((x) => x.youtube_video_id && x.status !== 'deleted')) {
    const pub = ctx.repos.artifacts.latest<PublishLog>(v.id, 'publish_log')?.data;
    if (!pub) continue;
    const hours = (now.getTime() - new Date(pub.uploadedAt).getTime()) / 3600_000;
    const have = new Set(ctx.repos.analytics.forVideo(v.id).map((s) => s.checkpointHours));
    const due = ctx.config.thresholds.analytics.checkpointsHours.filter((h) => h <= hours && !have.has(h));
    if (!due.length) continue;
    const r = await postPublish(ctx, v.id, hours);
    if (r.steps.every((s) => s.status === 'succeeded')) rep.analyticsUpdated.push(v.id);
    else rep.errors.push(`analytics ${v.id}: ${r.steps.find((s) => s.status !== 'succeeded')?.error}`);
  }

  // Re-learn the best publishing hours from mature analytics (no-op until there is enough data).
  learnPublishSlots(ctx, ctx.config.thresholds.analytics.minVideosForStrategicConclusion);

  // The learning loop across YouTube + Facebook + Instagram: measure every post, learn hours/content/length,
  // turn problems into written lessons the writers read next time.
  try { rep.learning = await learnCycle(ctx, now); } catch (err) { rep.errors.push(`learning: ${(err as Error).message.slice(0, 160)}`); }
  // Community manager: answer new comments on recent Shorts (engagement → the platforms show them to more people).
  try {
    const yt = ctx.providers.youtube;
    const social = socialFromEnv(ctx.config.env);
    if (!ctx.config.env.DRY_RUN && (yt.unansweredComments || social)) {
      const r = await answerComments(ctx, {
        unanswered: async (pl, id) => pl === 'youtube' ? (yt.unansweredComments ? yt.unansweredComments(id) : []) : social && pl !== 'tiktok' ? social.meta.unansweredComments(pl, id) : [],
        reply: async (pl, cid, text) => { if (pl === 'youtube') return yt.replyToComment!(cid, text); if (!social || pl === 'tiktok') throw new Error('not connected'); return social.meta.replyToComment(pl, cid, text); },
      }, now);
      rep.commentReplies = r.replied.length;
      if (tg) {
        const msg = repliesMessage(r.replied);
        if (msg) await tg.send(msg).catch(() => {});
        // Facebook needs one extra permission to reply; tell the owner once how to add it.
        if (r.notes.some((n) => n.startsWith('facebook') && /permission|#200|#10/i.test(n)) && !ctx.repos.artifacts.latest(null, 'fb_reply_hint')) {
          await tg.send('ℹ️ فيسبوك محتاج صلاحية زيادة عشان أرد على التعليقات هناك (pages_manage_engagement). إنستجرام ويوتيوب شغالين. قولّي في الشات وأنا أقولك تعملها إزاي في دقيقة.').catch(() => {});
          ctx.repos.artifacts.save({ videoId: null, kind: 'fb_reply_hint', agent: 'autopilot', data: { at: now.toISOString() } });
        }
      }
    }
  } catch (err) { rep.errors.push(`comments: ${(err as Error).message.slice(0, 160)}`); }

  // 3) Production, every day: a pack of 3 standalone Shorts (3 different topics), plus — on long-video days
  //    (2 a week) — one standalone long video (no Shorts cut from it). A blocked or crashed video doesn't use
  //    up the day: another topic is tried right away in the same run (max 3 failed attempts per format a day,
  //    and a time budget, so the free API quotas are never burnt in a loop).
  const planned = new Set(ctx.repos.artifacts.listKind('calendar_entry').map((a) => a.video_id));
  const t0 = Date.now();
  const budgetMs = o.productionBudgetMs ?? 100 * 60_000;
  let attempts = 0;
  let forcedDone = false;
  // Make sure a content calendar exists before deciding what is due today (first run / calendar ran out).
  if (o.produce !== false) {
    try {
      const niche = ctx.config.channel.niche ?? 'business-stories';
      const st = ctx.repos.artifacts.latest<StrategyOutput>(null, 'content_strategy')?.data;
      // Also re-plan when the cadence changed (e.g. 3 → 2 long videos a week): count longs in the next 7 days.
      const in7 = (c: { date: string }) => c.date >= day(now) && c.date < day(new Date(now.getTime() + 7 * 86_400_000));
      const cadenceChanged = st ? st.calendar.filter((c) => c.format === 'long' && in7(c)).length > ctx.config.channel.publishing.longPerWeek : false;
      if (!st || !st.calendar.some((c) => c.date >= day(now)) || cadenceChanged) {
        const avoid = [...ctx.repos.videos.list().map((v) => v.title), ...ctx.repos.artifacts.listKind<{ title: string }>('calendar_entry').map((a) => a.data.title)];
        await steps['trend-research'](ctx, { niche });
        await steps['content-strategy'](ctx, { niche, startDate: day(now), avoid });
      }
    } catch (err) { rep.errors.push(`planning: ${(err as Error).message}`); }
  }
  for (;;) {
    // Attempts that died only because the free voice quota was used up don't count toward the daily limit.
    // Same for the AI writing quota (Gemini 429): it's not the topic's fault, so it must not burn the day's 3 tries.
    const quotaOnly = (id: string) => (ctx.repos.artifacts.latest<{ blockers: string[] }>(id, 'auto_blocked')?.data.blockers ?? []).some((b) => b.includes('TTS_DAILY_QUOTA') || isDailyQuota(b));
    const todays = ctx.repos.videos.list().filter((v) => planned.has(v.id) && v.created_at.slice(0, 10) === day(now) && !quotaOnly(v.id));
    const ok = (f: string) => todays.some((v) => v.format === f && !ctx.repos.artifacts.latest(v.id, 'auto_blocked'));
    const failed = (f: string) => todays.filter((v) => v.format === f && ctx.repos.artifacts.latest(v.id, 'auto_blocked')).length;
    const strat = ctx.repos.artifacts.latest<StrategyOutput>(null, 'content_strategy')?.data;
    const producedNow = new Set([...ctx.repos.videos.list().map((v) => v.title), ...ctx.repos.artifacts.listKind<{ title: string }>('calendar_entry').map((a) => a.data.title)]);
    const longDue = ctx.config.channel.publishing.longPerWeek > 0 && !ok('long') && failed('long') < 3 && Boolean(longPlan(strat, producedNow, now));
    const packDue = !ok('short') && failed('short') < 3;
    if (o.produce === false) { rep.skippedProductionReason = 'production disabled for this run'; break; }
    const quota = ctx.repos.artifacts.latest<{ until: string }>(null, 'tts_quota_exhausted')?.data;
    if (quota && quota.until > now.toISOString()) { rep.skippedProductionReason = `voice quota used up — waiting until ${quota.until.slice(0, 16)} UTC`; break; }
    const llmQuota = ctx.repos.artifacts.latest<{ until: string }>(null, 'llm_quota_exhausted')?.data;
    if (llmQuota && llmQuota.until > new Date().toISOString()) { rep.skippedProductionReason = `AI writing quota used up — waiting until ${llmQuota.until.slice(0, 16)} UTC`; break; }
    if (attempts >= 5) break;
    const forceNow = o.force && !forcedDone;
    if (!forceNow && !longDue && !packDue) { if (!attempts) rep.skippedProductionReason = ok('short') ? "today's videos are already produced" : '3 attempts today were blocked — trying again tomorrow'; break; }
    if (attempts && Date.now() - t0 > budgetMs) { rep.skippedProductionReason = 'no time left in this run for another attempt — the next cycle continues'; break; }
    forcedDone = true;
    const want: 'long' | 'short' = forceNow && o.forceFormat ? o.forceFormat : longDue ? 'long' : 'short';
    if (attempts) ctx.logger.child('autopilot').warn('previous video blocked — trying another topic now', { attempt: attempts + 1 });
    attempts++;
    try {
      const niche = ctx.config.channel.niche ?? 'business-stories';
      let strategy = ctx.repos.artifacts.latest<StrategyOutput>(null, 'content_strategy')?.data;
      // Plan once (or when the calendar runs out): ideas → 90-day calendar.
      // Scripts rename videos, so remember which calendar entry each video came from.
      const produced = new Set([...ctx.repos.videos.list().map((v) => v.title), ...ctx.repos.artifacts.listKind<{ title: string }>('calendar_entry').map((a) => a.data.title)]);
      const replan = async () => {
        await steps['trend-research'](ctx, { niche });
        return (await steps['content-strategy'](ctx, { niche, startDate: day(now), avoid: [...produced] })) as StrategyOutput;
      };
      if (!strategy || !strategy.calendar.some((c) => c.date >= day(now))) strategy = await replan();
      let plan: CalendarEntry | undefined;
      if (want === 'long') {
        plan = longPlan(strategy, produced, now);
        // Topics ran out (everything planned is already produced) → plan fresh, non-repeating ideas.
        if (!plan && !strategy.calendar.some((c) => c.date >= day(now) && c.format === 'long' && !produced.has(c.title))) {
          strategy = await replan();
          plan = longPlan(strategy, produced, now);
        }
      } else {
        const topics = await planShortsPack(ctx, niche, [...produced]);
        if (topics.length === 3) plan = { day: 0, date: day(now), format: 'short', title: `شورتس: ${topics.map((t) => t.title).join(' | ')}`, pillar: 'shorts', kind: 'evergreen', topics };
      }
      if (!plan) { rep.skippedProductionReason = want === 'long' ? 'no unproduced long topic left in the calendar' : 'could not plan 3 new Shorts topics'; break; }
      else {
        const format = plan.format;
        const title = plan.title;
        const vid = ctx.repos.videos.create({ title, format, niche });
        ctx.repos.artifacts.save({ videoId: vid.id, kind: 'calendar_entry', agent: 'autopilot', data: plan });
        planned.add(vid.id);
        const r = await produceVideo(ctx, { title, videoId: vid.id, format, niche, render: true, renderSize: o.renderSize ?? 'full' });
        if (!r.completed) {
          const why = `${r.steps.find((s) => s.status !== 'succeeded')?.error}`;
          if (isDailyQuota(why)) {
            ctx.repos.artifacts.save({ videoId: null, kind: 'llm_quota_exhausted', agent: 'autopilot', data: { until: nextQuotaReset(new Date()) } });
          }
          if (why.includes('TTS_DAILY_QUOTA')) {
            const until = new Date(Date.now() + quotaResetSeconds(why) * 1000 + 5 * 60_000).toISOString();
            ctx.repos.artifacts.save({ videoId: null, kind: 'tts_quota_exhausted', agent: 'autopilot', data: { until } });
          }
          rep.errors.push(`produce "${plan.title}": ${why}`);
          // A crashed production doesn't use up the day either: the next cycle tries another topic.
          ctx.repos.artifacts.save({ videoId: r.videoId, kind: 'auto_blocked', agent: 'autopilot', data: { blockers: [`production failed: ${why.slice(0, 200)}`] } });
        }
        const fc = ctx.repos.artifacts.latest<FactCheckReport>(r.videoId, 'fact_check')?.data;
        try { writePackage(ctx, r.videoId); } catch (err) { rep.errors.push(`package: ${(err as Error).message}`); }
        rep.produced = {
          videoId: r.videoId,
          title: ctx.repos.videos.get(r.videoId)?.title ?? plan.title,
          recommendation: r.report?.recommendation ?? 'incomplete',
          claimsToVerify: fc?.claims.filter((c) => c.humanReviewRequired).length ?? 0,
        };
        // Full automation (opt-in): approve only when every gate passes, then upload right away.
        if (ctx.config.env.AUTO_APPROVE && r.report) {
          const render = ctx.repos.artifacts.latest<RenderOutput>(r.videoId, 'render')?.data;
          const qc = qualityChecklist(ctx, r.videoId);
          ctx.repos.artifacts.save({ videoId: r.videoId, kind: 'qc_checklist', agent: 'autopilot', data: qc });
          const blockers = r.approval ? [...autoApproveBlockers(r.report, render, ctx.config.thresholds.quality.minScoreToPublish), ...qcBlockers(qc)] : ['no approval request (blocked)', ...r.report.hardBlockers];
          if (!blockers.length && r.approval) {
            const publishAt = ctx.config.env.ALLOW_PUBLIC_PUBLISHING ? r.report.proposedPublishAt : undefined;
            approve(ctx, r.approval.id, { by: 'autopilot', visibility: 'private', publishAt, acceptRisks: true, note: 'Auto-approved: every quality, compliance and fact gate passed' });
            const pub = await publish(ctx, r.videoId);
            if (pub.status === 'succeeded') rep.published.push(r.videoId);
            else rep.errors.push(`publish ${r.videoId}: ${pub.error}`);
            rep.produced.autoApproved = true;
            rep.produced.publishAt = publishAt;
          } else {
            rep.produced.autoApproved = false;
            rep.produced.autoApproveBlockedBy = blockers;
            ctx.repos.artifacts.save({ videoId: r.videoId, kind: 'auto_blocked', agent: 'autopilot', data: { blockers } });
          }
        }
        // Telegram: the owner sees every finished Short right away, with its status and publishing time.
        if (tg) await sendShortsToTelegram(ctx, tg, r.videoId, rep.produced).catch((err) => rep.errors.push(`telegram: ${(err as Error).message.slice(0, 120)}`));
      }
    } catch (err) {
      rep.errors.push(`production: ${(err as Error).message.slice(0, 300)}`);
      if (isDailyQuota((err as Error).message)) ctx.repos.artifacts.save({ videoId: null, kind: 'llm_quota_exhausted', agent: 'autopilot', data: { until: nextQuotaReset(new Date()) } });
    }
    // Without full automation a human reviews each video: one per cycle is enough.
    if (!ctx.config.env.AUTO_APPROVE) break;
    if (rep.produced && !rep.produced.autoApproved) rep.blockedAttempts.push({ title: rep.produced.title, reason: rep.produced.autoApproveBlockedBy?.[0] ?? rep.errors.at(-1) ?? 'failed' });
  }

  // 4) What needs the human.
  rep.pendingApprovals = ctx.repos.approvals.pending().length;
  for (const v of ctx.repos.videos.list('reviewed')) {
    const fc = ctx.repos.artifacts.latest<FactCheckReport>(v.id, 'fact_check')?.data;
    const n = fc?.claims.filter((c) => c.humanReviewRequired).length ?? 0;
    if (n) rep.needsFactReview.push({ videoId: v.id, title: v.title, claims: n });
  }
  if (rep.produced?.autoApproved) notify('سر الموبايل: فيديو اتنشر تلقائياً', `${rep.produced.title.slice(0, 60)}${rep.produced.publishAt ? ` — هيظهر ${rep.produced.publishAt.slice(0, 16).replace('T', ' ')} UTC` : ' (private)'}`);
  else if (rep.produced?.autoApproveBlockedBy) notify('سر الموبايل: فيديو اتوقف', `مش هيتنشر: ${rep.produced.autoApproveBlockedBy[0]?.slice(0, 90)} — الدورة الجاية هتعمل موضوع تاني`);
  else if (rep.produced) notify('سر الموبايل: فيديو جديد جاهز', `${rep.produced.title.slice(0, 60)} — محتاج مراجعتك في لوحة التحكم`);
  else if (rep.pendingApprovals || rep.needsFactReview.length) notify('سر الموبايل', `فيه ${rep.pendingApprovals + rep.needsFactReview.length} فيديو مستني مراجعتك`);
  const locked = rep.published.filter((id) => (ctx.repos.artifacts.latest<PublishLog>(id, 'publish_log')?.data.warnings ?? []).some((w) => w.startsWith('YOUTUBE_LOCKED_PRIVATE')));
  if (locked.length) notify('سر الموبايل: YouTube قفل الفيديو private', 'لازم مراجعة YouTube API (مجانية) عشان النشر العلني التلقائي يشتغل');
  else if (rep.published.length) notify('سر الموبايل', `اترفع ${rep.published.length} فيديو على القناة`);
  if (rep.errors.length) notify('سر الموبايل: مشكلة', rep.errors[0]!.slice(0, 120));
  const decisions = (rep.learning ?? []).filter((l) => /^(🕒|📈|✂️|⚠️)/.test(l));
  if (decisions.length) notify('سر الموبايل: الفريق اتعلّم حاجة جديدة', decisions.join(' · ').slice(0, 600));

  if (tg && sent.length) await tg.send(sent.join('\n\n')).catch(() => {});
  // The Buffer key (TikTok) expires: remind the owner a week before, once a day.
  const exp = process.env.BUFFER_KEY_EXPIRES;
  if (tg && exp && /^\d{4}-\d{2}-\d{2}$/.test(exp) && new Date(`${exp}T00:00:00Z`).getTime() - now.getTime() < 7 * 86_400_000 && ctx.repos.artifacts.latest<{ date: string }>(null, 'buffer_key_reminder')?.data.date !== now.toISOString().slice(0, 10)) {
    await tg.send(`⏰ مفتاح Buffer (النشر على تيك توك) بينتهي يوم ${exp}. اعمل مفتاح جديد من Buffer ← الإعدادات ← API، وشغّل: bash ~/Desktop/youtube-ai-studio/scripts/connect-buffer.sh`).catch(() => {});
    ctx.repos.artifacts.save({ videoId: null, kind: 'buffer_key_reminder', agent: 'autopilot', data: { date: now.toISOString().slice(0, 10) } });
  }
  // Whatever the team learned this cycle reaches the owner on Telegram right away — each finding once only.
  if (tg) {
    const fresh = newLearnings(ctx, rep.learning ?? []);
    if (fresh.length) await tg.send(`🧠 الفريق اتعلّم حاجة جديدة:\n\n${fresh.join('\n\n')}`.slice(0, 4000))
      .then(() => ctx.repos.artifacts.save({ videoId: null, kind: 'telegram_learned', agent: 'autopilot', data: { lines: fresh } }))
      .catch(() => {});
  }
  // Keep the Telegram assistant's report / video list / viral alerts fresh.
  await syncBot(ctx, liveStats(ctx)).catch((err) => log.warn('bot sync failed', { error: (err as Error).message }));
  // Daily stats report on Telegram, once a day from 21:00 Cairo (19:00 UTC).
  const today = now.toISOString().slice(0, 10);
  if (tg && now.getUTCHours() >= 19 && ctx.repos.artifacts.latest<{ date: string }>(null, 'telegram_daily')?.data.date !== today) {
    await tg.send(dailyReport(ctx, now)).then(() => ctx.repos.artifacts.save({ videoId: null, kind: 'telegram_daily', agent: 'autopilot', data: { date: today } })).catch(() => {});
  }
  writeDailyReport(ctx, rep, now);
  ctx.audit.record({ actor: 'autopilot', action: 'cycle.completed', details: { published: rep.published.length, produced: rep.produced?.videoId, errors: rep.errors.length } });
  log.info('cycle done', { published: rep.published.length, analytics: rep.analyticsUpdated.length, produced: rep.produced?.videoId ?? null, errors: rep.errors.length });
  return rep;
}

/** Appends the cycle to reports/daily/YYYY-MM-DD.md (Arabic). */
export function writeDailyReport(ctx: AgentContext, rep: CycleReport, now: Date) {
  const dir = resolve(ctx.config.rootDir, 'reports/daily');
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${day(now)}.md`);
  const head = existsSync(path) ? '' : `# التقرير اليومي — ${day(now)}\n\nالتكلفة: $${ctx.cost.spentThisMonth().toFixed(2)} هذا الشهر (حد الميزانية $${ctx.config.env.MONTHLY_BUDGET_USD})\n`;
  const lines = [
    `\n## دورة ${now.toISOString().slice(11, 16)} UTC`,
    `- اترفع (private): ${rep.published.length ? rep.published.join('، ') : 'لا شيء'}`,
    `- تحليلات اتحدّثت: ${rep.analyticsUpdated.length}`,
    rep.produced ? `- فيديو جديد: **${rep.produced.title}** (${rep.produced.recommendation}) — ادعاءات محتاجة تأكيد: ${rep.produced.claimsToVerify}${rep.produced.autoApproved ? ` — ✅ اتوافق واتنشر تلقائياً${rep.produced.publishAt ? ` (موعد الظهور ${rep.produced.publishAt})` : ''}` : rep.produced.autoApproveBlockedBy ? ` — ⛔ متنشرش: ${rep.produced.autoApproveBlockedBy.join('؛ ')}` : ''}` : `- إنتاج: ${rep.skippedProductionReason ?? '—'}`,
    `- مستني موافقتك: ${rep.pendingApprovals} · محتاج تأكيد مصادر: ${rep.needsFactReview.length}`,
    ...(rep.learning ?? []).map((l) => `- ${l}`),
    ...rep.errors.map((e) => `- ⚠️ ${e}`),
  ];
  writeFileSync(path, (existsSync(path) ? readFileSync(path, 'utf8') : head) + lines.join('\n') + '\n');
  return path;
}

export function releaseLock(path: string) {
  rmSync(path, { force: true });
}

/** Lessons the team learned from its own mistakes and results, read by the writers before every script. */
export function addLesson(ctx: AgentContext, lesson: string, evidence: string) {
  const have = ctx.repos.knowledge.byCategory('lesson').map((k) => k.insight);
  if (!have.includes(lesson)) ctx.repos.knowledge.add({ category: 'lesson', insight: lesson, evidence, confidence: Date.now() / 1e13, sampleSize: 1 });
}

async function learnCycle(ctx: AgentContext, now: Date): Promise<string[]> {
  const social = socialFromEnv(ctx.config.env);
  // Reels posted by the social workflow → registered for measuring.
  if (social) {
    for (const e of await readPosted(social.queue).catch(() => [])) {
      if (e.platform === 'tiktok') continue; // analytics support is added separately once TikTok insights are connected
      registerPost(ctx, { platform: e.platform, external_id: e.id, video_id: e.videoId ?? null, secret_id: e.secretId ?? null, family: e.family ?? null, title: e.title, publish_at: e.at });
    }
  }
  // Backfill: every Short already uploaded to YouTube (incl. before the learner existed) is measured too.
  const lib = loadPhoneLibrary(ctx.config.rootDir);
  for (const a of ctx.repos.artifacts.listKind<PublishLog>('publish_log')) {
    const l = a.data;
    if (l.dryRun || !a.video_id || ctx.repos.videos.get(a.video_id)?.status === 'deleted') continue;
    const topics = ctx.repos.artifacts.latest<{ topics?: { subject: string; title: string }[] }>(a.video_id, 'calendar_entry')?.data.topics;
    const items = [{ youtubeVideoId: l.youtubeVideoId, title: topics?.[0]?.title ?? '', publishAt: l.publishAt }, ...(l.shorts ?? [])];
    items.forEach((it, i) => {
      if (!it.youtubeVideoId) return;
      const e = lib?.secrets.find((x) => x.id === topics?.[i]?.subject);
      registerPost(ctx, { platform: 'youtube', external_id: it.youtubeVideoId, video_id: a.video_id, secret_id: e?.id ?? null, family: e ? family(e) : null, title: it.title.replace(/\s*#Shorts$/, '') || topics?.[i]?.title, publish_at: it.publishAt ?? l.uploadedAt });
    });
  }
  const yt = ctx.providers.youtube;
  const lines = await runLearning(ctx, {
    youtube: yt.statistics ? (ids) => yt.statistics!(ids) : undefined,
    youtubeRetention: yt.name.startsWith('mock') ? undefined : async (id) => (await yt.metrics(id, 72)).avgPercentViewed,
    youtubeCurve: yt.retentionCurve ? (id) => yt.retentionCurve!(id) : undefined,
    facebook: social ? (id) => social.meta.facebookStats(id) : undefined,
    instagram: social ? (id) => social.meta.instagramStats(id) : undefined,
  }, now);
  // The analyst: why did some Shorts get few views, and what changes next (once a day).
  lines.push(...await analyzePerformance(ctx, now).catch((err) => [`⚠️ محلل الأداء ما اشتغلش: ${(err as Error).message.slice(0, 120)}`]));
  // Mistakes → lessons (what to avoid next time), wins → patterns (what to repeat).
  for (const l of lines.filter((x) => x.startsWith('⚠️') && x.includes('البداية'))) addLesson(ctx, 'Viewers left early on a recent Short: open with the surprising benefit in the first 5 words and show the code/setting immediately.', l);
  for (const b of ctx.repos.artifacts.listKind<{ blockers: string[] }>('auto_blocked').filter((a) => a.created_at > new Date(now.getTime() - 86_400_000).toISOString())) {
    for (const reason of b.data.blockers.filter((x) => !isInfraProblem(x)).slice(0, 2)) addLesson(ctx, `A video was blocked before publishing because: ${reason.slice(0, 180)} — prevent this in the script.`, b.video_id ?? '');
  }
  for (const r of ctx.repos.artifacts.listKind<{ log: string[] }>('pack_repair').filter((a) => a.created_at > new Date(now.getTime() - 86_400_000).toISOString())) {
    for (const x of r.data.log.slice(0, 2)) addLesson(ctx, `A Short needed repair (${x.slice(0, 160)}) — write each Short complete on the first try.`, r.video_id ?? '');
  }
  return lines;
}

/** Learning lines not sent to the owner before (problem alerts repeat every cycle; measuring hiccups are noise). */
export function newLearnings(ctx: AgentContext, lines: string[]): string[] {
  const seen = new Set(ctx.repos.artifacts.listKind<{ lines: string[] }>('telegram_learned').flatMap((a) => a.data.lines));
  return [...new Set(lines)].filter((l) => /^(🕒|📈|✂️|⚠️|🔎)/.test(l) && !/قياس .* فشل|محلل الأداء ما اشتغلش/.test(l) && !seen.has(l));
}

/** Gemini free-tier daily quota (not a per-minute burst): retrying today only burns attempts and topics. */
export function isDailyQuota(msg: string): boolean {
  return /429|RESOURCE_EXHAUSTED|quota/i.test(msg) && /per ?day|PerDay|free_tier_requests|daily|exceeded your current quota/i.test(msg);
}
/** Gemini daily quotas reset at midnight Pacific time (~08:00 UTC); wait until a bit after. */
export function nextQuotaReset(now: Date): string {
  const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 8, 10));
  if (t <= now) t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString();
}

/** Sends each rendered Short of a production to Telegram as a video, captioned with title + status + times. */
async function sendShortsToTelegram(ctx: AgentContext, tg: Telegram, videoId: string, produced: NonNullable<CycleReport['produced']>) {
  const render = ctx.repos.artifacts.latest<RenderOutput>(videoId, 'render')?.data;
  const pub = ctx.repos.artifacts.latest<PublishLog>(videoId, 'publish_log')?.data;
  if (!render?.shorts?.length) {
    await tg.send(`⚠️ محاولة إنتاج ما كملتش: ${produced.title.slice(0, 120)}\n${(produced.autoApproveBlockedBy ?? []).slice(0, 2).join('\n')}`);
    return;
  }
  const ytTimes = pub ? [pub.publishAt, ...(pub.shorts ?? []).map((x) => x.publishAt)] : [];
  const extras = ctx.repos.artifacts.latest<{ shorts: { title: string; caption: string; tiktokError?: string; facebookAt?: string; instagramAt?: string; tiktokAt?: string }[] }>(videoId, 'social_extras')?.data;
  const blocked = produced.autoApproved ? undefined : (produced.autoApproveBlockedBy ?? ['سبب غير معروف'])[0]!.slice(0, 200);
  const sentVideos: { title: string; file_id?: string; publishAt?: string; blocked?: string }[] = [];
  for (const [i, sh] of render.shorts.entries()) {
    const x = extras?.shorts.find((e) => e.title === sh.title);
    const status = blocked ? `⛔ اتوقف ومش هيتنشر: ${blocked}`
      : `✅ هينزل:\n▶️ يوتيوب ${cairoTime(ytTimes[i])}${x?.facebookAt ? `\n📘 فيسبوك ${cairoTime(x.facebookAt)}` : ''}${x?.instagramAt ? `\n📸 إنستجرام ${cairoTime(x.instagramAt)}` : ''}${x?.tiktokAt ? `\n🎵 تيك توك ${cairoTime(x.tiktokAt)}` : ''}`;
    const fileId = await tg.video(sh.path, `🎬 ${sh.title}\n${status}\nمدته ${Math.round(sh.durationSec)} ثانية`);
    // TikTok can't be posted automatically yet: the video above + this ready caption = post it in 10 seconds.
    if (!blocked && x?.caption && !x.tiktokAt) await tg.send(`🎵 جاهز لتيك توك — احفظ الفيديو اللي فوق وانسخ الكلام ده:\n\n${x.caption}`).catch(() => {});
    sentVideos.push({ title: sh.title, file_id: fileId, publishAt: blocked ? undefined : ytTimes[i] ?? undefined, blocked });
  }
  // The assistant bot re-sends these on request ("فيديو") by file_id, without uploading again.
  ctx.repos.artifacts.save({ videoId, kind: 'telegram_videos', agent: 'autopilot', data: { shorts: sentVideos } });
}

/** Live numbers for the assistant bot from the connected platforms. */
export function liveStats(ctx: AgentContext): LiveStats {
  const yt = ctx.providers.youtube;
  const social = socialFromEnv(ctx.config.env);
  return {
    youtubeVideos: yt.statistics ? (ids) => yt.statistics!(ids) : undefined,
    youtubeChannel: yt.channelStats ? () => yt.channelStats!() : undefined,
    facebook: social ? (id) => social.meta.facebookStats(id) : undefined,
    instagram: social ? (id) => social.meta.instagramStats(id) : undefined,
    followers: social ? () => social.meta.followers() : undefined,
  };
}
