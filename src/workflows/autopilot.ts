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

export interface CycleOptions {
  now?: Date;
  /** Skip production (e.g. analytics-only runs). */
  productionBudgetMs?: number; produce?: boolean; /** Produce even if today's video already exists (manual test run). */ force?: boolean;
  notify?: (title: string, body: string) => void;
  renderSize?: 'full' | 'preview';
}

export interface CycleReport {
  startedAt: string;
  published: string[];
  analyticsUpdated: string[];
  produced: { videoId: string; title: string; recommendation: string; claimsToVerify: number; autoApproved?: boolean; autoApproveBlockedBy?: string[]; publishAt?: string } | null;
  skippedProductionReason?: string;
  pendingApprovals: number;
  needsFactReview: { videoId: string; title: string; claims: number }[];
  errors: string[];
  /** Videos blocked in this run before a later attempt (if any) succeeded. */
  blockedAttempts: { title: string; reason: string }[];
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

const PackLLM = z.object({ topics: z.array(z.object({ title: z.string().min(5), subject: z.string().min(2), angle: z.string() })).min(3) });
/** Three DIFFERENT, clear, specific Shorts topics ("سر …", "لماذا …", "معلومة عن …"), never repeating past titles. */
export async function planShortsPack(ctx: AgentContext, niche: string, avoid: string[]) {
  const r = await ctx.providers.llm.generateJson({
    task: 'shorts.topics',
    tier: 'light',
    system: 'You plan YouTube Shorts for an Arabic business-stories channel. Propose 5 Shorts topics, each about a DIFFERENT real company, brand, product or founder, with one clear surprising fact or secret that can be told in 45 seconds. Title in Arabic (Modern Standard, simple), 4–9 words, naming the subject explicitly, e.g. "سر شعار أمازون المبتسم", "لماذا لون فيسبوك أزرق؟", "معلومة لا تعرفها عن كوكاكولا". subject = the English Wikipedia name of the company/product/person. angle = the specific fact or secret. Never reuse a topic from `avoid`. JSON only.',
    prompt: JSON.stringify({ niche, avoid: avoid.slice(-150) }),
    schema: PackLLM,
    maxOutputTokens: 3000,
  }).catch(() => undefined);
  const seen = new Set<string>();
  const picked: { title: string; subject: string; angle: string }[] = [];
  for (const t of r?.data.topics ?? []) {
    const key = t.subject.toLowerCase();
    if (seen.has(key) || isDuplicateTopic(t.title, new Set(avoid))) continue;
    seen.add(key);
    picked.push(t);
    if (picked.length === 3) break;
  }
  return picked;
}

export async function runCycle(ctx: AgentContext, o: CycleOptions = {}): Promise<CycleReport> {
  const now = o.now ?? new Date();
  const notify = o.notify ?? macNotify;
  const rep: CycleReport = { startedAt: now.toISOString(), published: [], analyticsUpdated: [], produced: null, pendingApprovals: 0, needsFactReview: [], errors: [], blockedAttempts: [] };
  const log = ctx.logger.child('autopilot');

  // 1) Approved → upload (private).
  for (const v of ctx.repos.videos.list('approved')) {
    const r = await publish(ctx, v.id);
    if (r.status === 'succeeded') rep.published.push(v.id);
    else rep.errors.push(`publish ${v.id}: ${r.error}`);
  }

  // 2) Analytics for uploaded videos, by hours since upload.
  for (const v of ctx.repos.videos.list().filter((x) => x.youtube_video_id)) {
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
      if (!st || !st.calendar.some((c) => c.date >= day(now))) {
        const avoid = [...ctx.repos.videos.list().map((v) => v.title), ...ctx.repos.artifacts.listKind<{ title: string }>('calendar_entry').map((a) => a.data.title)];
        await steps['trend-research'](ctx, { niche });
        await steps['content-strategy'](ctx, { niche, startDate: day(now), avoid });
      }
    } catch (err) { rep.errors.push(`planning: ${(err as Error).message}`); }
  }
  for (;;) {
    // Attempts that died only because the free voice quota was used up don't count toward the daily limit.
    const quotaOnly = (id: string) => (ctx.repos.artifacts.latest<{ blockers: string[] }>(id, 'auto_blocked')?.data.blockers ?? []).some((b) => b.includes('TTS_DAILY_QUOTA'));
    const todays = ctx.repos.videos.list().filter((v) => planned.has(v.id) && v.created_at.slice(0, 10) === day(now) && !quotaOnly(v.id));
    const ok = (f: string) => todays.some((v) => v.format === f && !ctx.repos.artifacts.latest(v.id, 'auto_blocked'));
    const failed = (f: string) => todays.filter((v) => v.format === f && ctx.repos.artifacts.latest(v.id, 'auto_blocked')).length;
    const strat = ctx.repos.artifacts.latest<StrategyOutput>(null, 'content_strategy')?.data;
    const producedNow = new Set([...ctx.repos.videos.list().map((v) => v.title), ...ctx.repos.artifacts.listKind<{ title: string }>('calendar_entry').map((a) => a.data.title)]);
    const longDue = !ok('long') && failed('long') < 3 && Boolean(longPlan(strat, producedNow, now));
    const packDue = !ok('short') && failed('short') < 3;
    if (o.produce === false) { rep.skippedProductionReason = 'production disabled for this run'; break; }
    const quota = ctx.repos.artifacts.latest<{ until: string }>(null, 'tts_quota_exhausted')?.data;
    if (quota && quota.until > now.toISOString()) { rep.skippedProductionReason = `voice quota used up — waiting until ${quota.until.slice(0, 16)} UTC`; break; }
    if (attempts >= 5) break;
    const forceNow = o.force && !forcedDone;
    if (!forceNow && !longDue && !packDue) { if (!attempts) rep.skippedProductionReason = ok('short') ? "today's videos are already produced" : '3 attempts today were blocked — trying again tomorrow'; break; }
    if (attempts && Date.now() - t0 > budgetMs) { rep.skippedProductionReason = 'no time left in this run for another attempt — the next cycle continues'; break; }
    forcedDone = true;
    const want: 'long' | 'short' = longDue ? 'long' : 'short';
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
      }
    } catch (err) {
      rep.errors.push(`production: ${(err as Error).message}`);
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
  if (rep.produced?.autoApproved) notify('سر البراند: فيديو اتنشر تلقائياً', `${rep.produced.title.slice(0, 60)}${rep.produced.publishAt ? ` — هيظهر ${rep.produced.publishAt.slice(0, 16).replace('T', ' ')} UTC` : ' (private)'}`);
  else if (rep.produced?.autoApproveBlockedBy) notify('سر البراند: فيديو اتوقف', `مش هيتنشر: ${rep.produced.autoApproveBlockedBy[0]?.slice(0, 90)} — الدورة الجاية هتعمل موضوع تاني`);
  else if (rep.produced) notify('سر البراند: فيديو جديد جاهز', `${rep.produced.title.slice(0, 60)} — محتاج مراجعتك في لوحة التحكم`);
  else if (rep.pendingApprovals || rep.needsFactReview.length) notify('سر البراند', `فيه ${rep.pendingApprovals + rep.needsFactReview.length} فيديو مستني مراجعتك`);
  const locked = rep.published.filter((id) => (ctx.repos.artifacts.latest<PublishLog>(id, 'publish_log')?.data.warnings ?? []).some((w) => w.startsWith('YOUTUBE_LOCKED_PRIVATE')));
  if (locked.length) notify('سر البراند: YouTube قفل الفيديو private', 'لازم مراجعة YouTube API (مجانية) عشان النشر العلني التلقائي يشتغل');
  else if (rep.published.length) notify('سر البراند', `اترفع ${rep.published.length} فيديو على القناة`);
  if (rep.errors.length) notify('سر البراند: مشكلة', rep.errors[0]!.slice(0, 120));

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
    ...rep.errors.map((e) => `- ⚠️ ${e}`),
  ];
  writeFileSync(path, (existsSync(path) ? readFileSync(path, 'utf8') : head) + lines.join('\n') + '\n');
  return path;
}

export function releaseLock(path: string) {
  rmSync(path, { force: true });
}
