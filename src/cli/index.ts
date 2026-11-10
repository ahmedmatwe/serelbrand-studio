#!/usr/bin/env node
/**
 * CLI for YouTube AI Studio.  Run: npm run cli -- <command> [args]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createContext } from '../context.ts';
import { AGENT_NAMES, type StepName } from '../workflows/steps.ts';
import { renderNicheReport } from '../reports/niche-report.ts';
import type { NicheSelectionReport } from '../agents/niche/niche-selector.ts';
import { StudioError } from '../core/errors.ts';
import { daily, postPublish, produceVideo, publish, review, type ProduceResult } from '../workflows/orchestrator.ts';
import { approve, reject, verifyClaim } from '../publishing/approval.ts';
import { renderVideoReport } from '../reports/html.ts';
import type { AgentContext } from '../agents/base.ts';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { loadAuth, readClientJson, runLoopbackFlow, saveAuth, TokenSource } from '../providers/youtube/oauth.ts';
import { RealYouTube } from '../providers/youtube/youtube.ts';
import { YOUTUBE_AUTH_FILE } from '../core/config.ts';
import { acquireLock, liveStats, releaseLock, runCycle } from '../workflows/autopilot.ts';
import { sendQueuedVideos, syncBot } from '../publishing/bot-sync.ts';
import { startDashboard } from '../dashboard/server.ts';
import { processQueue, readPosted, socialFromEnv } from '../publishing/social.ts';
import { telegramFromEnv } from '../publishing/telegram.ts';
import { installSchedule, kickSchedule, removeSchedule, scheduleStatus } from '../workflows/schedule-macos.ts';

const HELP = `
YouTube AI Studio — CLI   (DRY_RUN is on unless .env says otherwise)

Research
  niche                          Score 12 niches, write reports/niche-report.md
  trends --niche <name>          Generate & score topic ideas
  strategy --niche <name>        Pillars, series, 30/60/90-day calendar

Single video (each step runs as a queued job)
  video:new --title <t> [--format long|short]
  run <step> <videoId>           step = scriptwriter | fact-checker | production-planner | thumbnail | seo | compliance | quality
  show <videoId> <kind>          Print an artifact (script, fact_check, blueprint, thumbnails, seo_package, compliance_report, quality_report)
  videos                         List videos

Workflows (Orchestrator)
  produce --title <t> [--format long|short] [--render [--preview]]
                                              Full chain (+ local MP4/Shorts/thumbnail render) → report → approval request
  render <videoId> [--preview]                Render MP4 + vertical Short + thumbnail PNG locally (free)
  daily --niche <name>                        Research → best new idea → produce
  claims <videoId>                            List claims with suggested sources and status
  verify <videoId> <claim#> [--url <https://…>] [--source-title t] [--date YYYY-MM-DD]
                                              Human-verify a claim (omit --url to confirm the suggested source)
  review <videoId>                            Re-run compliance + quality, request approval again
  approvals                                   Pending approval requests
  approve <approvalId> [--visibility private|unlisted|public] [--publish-at ISO] [--accept-risks --note "…"]
  reject <approvalId> --note "…"
  publish <videoId>                           Upload an approved video (mock in dry-run)
  analytics <videoId> --hours <n>             Capture checkpoints due by hour n, then diagnose
  report <videoId>                            Write reports/generated/<videoId>.html
  package <videoId>                           Write the 17-part production package (reports/packages/)

Autopilot
  social                                      Post due Shorts on Facebook + Instagram (queue)
  autopilot [--preview]                       One cycle: upload approved → analytics → produce today's video → report
  dashboard                                   Open the approval dashboard (http://127.0.0.1:8787)
  schedule:install | schedule:remove | schedule:status | schedule:run-now
                                              Run autopilot automatically every 2 hours (macOS launchd)

YouTube
  youtube:auth --client <client_secret.json>  Link your channel (you sign in on Google's page; uploads stay private)
  youtube:status                              Show the linked channel

Operations
  agents                         Agent pause status
  pause <agent|*> [--reason r]   Pause an agent (or all)
  resume <agent|*>
  jobs [--status s]              List jobs
  rerun <jobId|--all>            Re-queue failed jobs and run them
  costs                          Spend this month
  audit [--limit n]              Recent audit log
`;

const out = (x: unknown) => process.stdout.write((typeof x === 'string' ? x : JSON.stringify(x, null, 2)) + '\n');

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      niche: { type: 'string' }, title: { type: 'string' }, format: { type: 'string', default: 'long' },
      status: { type: 'string' }, reason: { type: 'string' }, limit: { type: 'string', default: '20' }, all: { type: 'boolean' },
      url: { type: 'string' }, 'source-title': { type: 'string' }, date: { type: 'string' }, note: { type: 'string' },
      visibility: { type: 'string' }, 'publish-at': { type: 'string' }, 'accept-risks': { type: 'boolean' }, hours: { type: 'string' },
      by: { type: 'string', default: process.env.USER ?? 'human' },
      render: { type: 'boolean' }, preview: { type: 'boolean' }, client: { type: 'string' }, check: { type: 'boolean' }, 'send-report': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [cmd, a1, a2] = positionals;
  if (!cmd || values.help) return out(HELP);

  // YouTube linking runs before the context: the channel may not be linked yet.
  if (cmd === 'youtube:auth' || cmd === 'youtube:status') return youtubeCommand(cmd, values.client);
  if (cmd?.startsWith('schedule:')) {
    if (cmd === 'schedule:install') return out(`✓ التشغيل التلقائي اتفعّل (كل ساعتين)\n  ${installSchedule(process.cwd())}\n  السجل: data/logs/autopilot.log`);
    if (cmd === 'schedule:remove') { removeSchedule(); return out('✓ التشغيل التلقائي اتوقف'); }
    if (cmd === 'schedule:run-now') { kickSchedule(); return out('✓ دورة اشتغلت دلوقتي في الخلفية — تابع data/logs/autopilot.log'); }
    return out(scheduleStatus());
  }

  const ctx = createContext();
  const runStep = async (step: StepName, payload: unknown) => {
    const id = ctx.queue.enqueue(step, payload);
    await ctx.queue.drain();
    const job = ctx.queue.get(id)!;
    if (job.status !== 'succeeded') throw new StudioError('JOB_FAILED', `Job ${id} ${job.status}: ${job.last_error ?? ''}`);
    return job;
  };

  try {
    switch (cmd) {
      case 'autopilot': {
        const lock = resolve(ctx.config.rootDir, 'data/autopilot.lock');
        if (!acquireLock(lock)) { out('دورة تانية شغالة دلوقتي — اتخطيت'); break; }
        try {
          const r = await runCycle(ctx, { renderSize: values.preview ? 'preview' : 'full', force: process.env.FORCE_PRODUCE === 'true', forceFormat: process.env.FORCE_FORMAT === 'long' || process.env.FORCE_FORMAT === 'short' ? process.env.FORCE_FORMAT : undefined });
          out({ published: r.published, analytics: r.analyticsUpdated.length, produced: r.produced, skipped: r.skippedProductionReason, pendingApprovals: r.pendingApprovals, needsFactReview: r.needsFactReview.length, errors: r.errors });
        } finally { releaseLock(lock); }
        break;
      }
      case 'social': {
        // Posts the Shorts whose time has come on Facebook + Instagram (run by .github/workflows/social.yml).
        const social = socialFromEnv(ctx.config.env);
        if (!social) return out('Facebook/Instagram not connected (META_PAGE_ID / META_PAGE_TOKEN / GITHUB_TOKEN missing) — nothing to do.');
        if (process.argv.includes('--check')) {
          const c = await social.meta.check();
          const lines = [`✓ Facebook Page: ${c.page}`, c.instagram ? `✓ Instagram: @${c.instagram}` : '✗ No Instagram professional account linked to this Page', `scopes: ${(c.scopes ?? ['?']).join(',')}`, `page status: ${JSON.stringify(c.status)}`];
          // Insights check on the latest posted Reels (proves the analytics permissions work).
          const posted = await readPosted(social.queue).catch(() => []);
          for (const plat of ['facebook', 'instagram'] as const) {
            const last = posted.filter((p) => p.platform === plat).at(-1);
            if (!last) continue;
            const st = await (plat === 'facebook' ? social.meta.facebookStats(last.id) : social.meta.instagramStats(last.id)).catch((e: Error) => ({ error: e.message.slice(0, 160) }));
            lines.push(`${plat} stats for "${last.title}": ${JSON.stringify(st)}`);
          }
          return out(lines.join('\n'));
        }
        const log = await processQueue(social.queue, social.meta, new Date(), resolve(ctx.config.rootDir, 'data'), social.tiktok);
        // Tell the owner on Telegram what went out (or failed) on Facebook / Instagram.
        const tgc = telegramFromEnv();
        if (tgc && log.length) await tgc.send(log.map((l) => l.replace(/^facebook:/, '📘 فيسبوك:').replace(/^instagram:/, '📸 إنستجرام:').replace(/ posted /, ' اتنشر ').replace(/ FAILED /, ' فشل ')).join('\n')).catch(() => {});
        return out(log.length ? log.join('\n') : 'Nothing due.');
      }
      case 'bot:videos': {
        // The bot asked for Shorts it has no Telegram copy of: fetch them from the queue and send them.
        // Only plain queue file names (time__id__short-N.mp4) are accepted.
        const names = (positionals[1] ?? '').split(',').map((x) => x.trim()).filter((x) => /^[\w.-]{1,120}\.mp4$/.test(x)).slice(0, 10);
        return out((await sendQueuedVideos(names, resolve(ctx.config.rootDir, 'data'))).join('\n'));
      }
      case 'bot:sync': {
        // Hourly (social.yml): live report, video list and viral alerts for the Telegram assistant.
        // --send-report: someone asked the bot for «تقرير» → the fresh report also goes straight to the chat.
        return out(await syncBot(ctx, liveStats(ctx), new Date(), { sendReport: process.argv.includes('--send-report') }));
      }
      case 'dashboard': {
        const d = await startDashboard(ctx);
        out(`✓ لوحة التحكم شغالة: ${d.url}\n  (اقفلها بـ Ctrl+C)`);
        execFile('open', [d.url], () => {});
        await new Promise(() => {}); // keep serving until Ctrl+C
        break;
      }
      case 'produce': {
        if (!values.title) throw new StudioError('USAGE', '--title is required');
        printProduce(ctx, await produceVideo(ctx, { title: values.title, format: values.format === 'short' ? 'short' : 'long', render: values.render, renderSize: values.preview ? 'preview' : 'full' }));
        break;
      }
      case 'daily': {
        if (!values.niche) throw new StudioError('USAGE', '--niche is required');
        const r = await daily(ctx, values.niche);
        if (!r.result) out('No new idea to produce today.');
        else { out(`Picked: ${r.picked!.title} (score ${r.picked!.opportunityScore})`); printProduce(ctx, r.result); }
        break;
      }
      case 'verify': {
        if (!a1 || a2 === undefined) throw new StudioError('USAGE', 'Usage: verify <videoId> <claim#> [--url https://…]  (no --url = confirm the suggested source)');
        const r = verifyClaim(ctx, a1, Number(a2), { url: values.url, title: values['source-title'], date: values.date, by: values.by! });
        out(`✓ claim #${a2} verified. ${r.summary}\nNext: npm run cli -- review ${a1}`);
        break;
      }
      case 'render': {
        if (!a1) throw new StudioError('USAGE', 'Usage: render <videoId> [--preview]');
        const j = await runStep('renderer', { videoId: a1, size: values.preview ? 'preview' : 'full' });
        const r = ctx.repos.artifacts.latest<{ videoPath: string; thumbnailPath: string; captionsPath: string; durationSec: number; shorts: { path: string; durationSec: number }[]; measurements: { notes: string[]; audioScore: number } }>(a1, 'render')!.data;
        out(`✓ rendered (job ${j.id})\n  video:     ${r.videoPath} (${r.durationSec}s)\n  thumbnail: ${r.thumbnailPath}\n  captions:  ${r.captionsPath}`);
        for (const s of r.shorts) out(`  short:     ${s.path} (${s.durationSec}s)`);
        for (const n of r.measurements.notes) out(`  • ${n}`);
        out(`\nNext: npm run cli -- review ${a1}`);
        break;
      }
      case 'claims': {
        if (!a1) throw new StudioError('USAGE', 'Usage: claims <videoId>');
        const fc = ctx.repos.artifacts.latest<{ claims: { claim: string; type: string; status: string; sourceUrl: string | null }[] }>(a1, 'fact_check')?.data;
        out(fc ? fc.claims.map((c, i) => `#${i} [${c.status}] (${c.type}) ${c.claim}\n     ${c.sourceUrl ?? '— no source'}`).join('\n') : 'No fact-check yet');
        break;
      }
      case 'review': {
        if (!a1) throw new StudioError('USAGE', 'Usage: review <videoId>');
        printProduce(ctx, await review(ctx, a1));
        break;
      }
      case 'approvals':
        out(ctx.repos.approvals.pending().map((a) => `${a.id}  ${a.video_id}  ${(JSON.parse(a.report) as { title: string }).title}`).join('\n') || 'No pending approvals');
        break;
      case 'approve': {
        if (!a1) throw new StudioError('USAGE', 'Usage: approve <approvalId>');
        const r = approve(ctx, a1, { by: values.by!, visibility: values.visibility as never, publishAt: values['publish-at'], acceptRisks: values['accept-risks'], note: values.note });
        out(`✓ approved (${r.requested_visibility}). Next: npm run cli -- publish ${r.video_id}`);
        break;
      }
      case 'reject': {
        if (!a1 || !values.note) throw new StudioError('USAGE', 'Usage: reject <approvalId> --note "reason"');
        reject(ctx, a1, values.by!, values.note);
        out('✓ rejected');
        break;
      }
      case 'publish': {
        if (!a1) throw new StudioError('USAGE', 'Usage: publish <videoId>');
        const r = await publish(ctx, a1);
        if (r.status !== 'succeeded') throw new StudioError('PUBLISH', `Publish ${r.status}: ${r.error}`);
        const v = ctx.repos.videos.get(a1)!;
        out(`✓ uploaded: ${v.youtube_video_id} (${v.visibility})${ctx.config.env.DRY_RUN ? ' [dry-run mock]' : ''}`);
        break;
      }
      case 'analytics': {
        if (!a1) throw new StudioError('USAGE', 'Usage: analytics <videoId> --hours <n>');
        const r = await postPublish(ctx, a1, Number(values.hours ?? 24));
        for (const s of r.steps) if (s.status !== 'succeeded') throw new StudioError('ANALYTICS', `${s.step} ${s.status}: ${s.error}`);
        const o = r.report!;
        out(`Checkpoint ${o.checkpointHours}h · confidence ${Math.round(o.confidence * 100)}% · sample ${o.sampleSize}`);
        for (const d of o.diagnoses) out(`- ${d.finding}\n    ${d.recommendations.map((x) => `${x.variable}: ${x.action}`).join('\n    ')}`);
        for (const c of o.caveats) out(`  ⚠ ${c}`);
        break;
      }
      case 'youtube:private': {
        const ids = positionals.slice(1);
        if (!ids.length) throw new StudioError('USAGE', 'Usage: youtube:private <youtubeVideoId...>');
        const yt = ctx.providers.youtube as { makePrivate?: (ids: string[]) => Promise<{ id: string; was: string }[]> };
        if (!yt.makePrivate) throw new StudioError('USAGE', 'Needs the real YouTube provider (DRY_RUN=false, YOUTUBE_PROVIDER=real)');
        for (const r of await yt.makePrivate(ids)) out(`${r.id}: ${r.was} → private`);
        break;
      }
      case 'package': {
        if (!a1) throw new StudioError('USAGE', 'Usage: package <videoId>');
        const { writePackage } = await import('../reports/package.ts');
        out(`Production package: ${writePackage(ctx, a1)}`);
        break;
      }
      case 'report': {
        if (!a1) throw new StudioError('USAGE', 'Usage: report <videoId>');
        out(`Report: ${writeHtml(ctx, a1)}`);
        break;
      }
      case 'niche': {
        await runStep('niche-selector', {});
        const r = ctx.repos.artifacts.latest<NicheSelectionReport>(null, 'niche_report')!.data;
        const dir = resolve(ctx.config.rootDir, 'reports');
        mkdirSync(dir, { recursive: true });
        const path = resolve(dir, 'niche-report.md');
        writeFileSync(path, renderNicheReport(r));
        out(r.ranked.map((n, i) => `${String(i + 1).padStart(2)}. ${String(n.score).padStart(3)}  ${n.eligible ? ' ' : '✗'} ${n.nameAr}`).join('\n'));
        out(`\nPrimary: ${r.primary}  Backups: ${r.backups.join(', ')}  Confidence: ${r.confidence.level} (${r.confidence.value})\nReport: ${path}`);
        break;
      }
      case 'trends': {
        if (!values.niche) throw new StudioError('USAGE', '--niche is required');
        await runStep('trend-research', { niche: values.niche });
        const r = ctx.repos.artifacts.latest<{ ideas: { title: string; opportunityScore: number; recommendedFormat: string }[] }>(null, 'topic_ideas')!.data;
        out(r.ideas.map((i) => `${String(i.opportunityScore).padStart(3)}  [${i.recommendedFormat}] ${i.title}`).join('\n'));
        break;
      }
      case 'strategy': {
        if (!values.niche) throw new StudioError('USAGE', '--niche is required');
        await runStep('content-strategy', { niche: values.niche });
        const r = ctx.repos.artifacts.latest<{ summary: unknown; pillars: { name: string; share: number }[]; calendar: { day: number; format: string; title: string }[] }>(null, 'content_strategy')!.data;
        out({ pillars: r.pillars.map((p) => `${p.name} (${Math.round(p.share * 100)}%)`), summary: r.summary, first14Days: r.calendar.filter((c) => c.day <= 14).map((c) => `D${c.day} ${c.format}: ${c.title}`) });
        break;
      }
      case 'video:new': {
        if (!values.title) throw new StudioError('USAGE', '--title is required');
        const format = values.format === 'short' ? 'short' : 'long';
        const v = ctx.repos.videos.create({ title: values.title, format });
        ctx.audit.record({ actor: 'human', action: 'video.created', target: v.id });
        out(v);
        break;
      }
      case 'run': {
        if (!a1 || !a2 || !(AGENT_NAMES as readonly string[]).includes(a1)) throw new StudioError('USAGE', `Usage: run <${AGENT_NAMES.join('|')}> <videoId>`);
        const job = await runStep(a1 as StepName, { videoId: a2 });
        out(`✓ ${a1} done (job ${job.id}, attempts ${job.attempts})`);
        break;
      }
      case 'show': {
        if (!a1 || !a2) throw new StudioError('USAGE', 'Usage: show <videoId> <kind>');
        out(ctx.repos.artifacts.latest(a1, a2)?.data ?? `No ${a2} for ${a1}`);
        break;
      }
      case 'videos':
        out(ctx.repos.videos.list().map((v) => `${v.id}  ${v.status.padEnd(16)} ${v.format.padEnd(5)} ${v.title}`).join('\n') || 'No videos');
        break;
      case 'agents': {
        const st = new Map(ctx.repos.agentState.list().map((s) => [s.agent, s]));
        out(['*', ...AGENT_NAMES].map((a) => `${st.get(a)?.paused ? '⏸ paused ' : '▶ active '} ${a}${st.get(a)?.reason ? ` — ${st.get(a)!.reason}` : ''}`).join('\n'));
        break;
      }
      case 'pause':
      case 'resume': {
        if (!a1) throw new StudioError('USAGE', `Usage: ${cmd} <agent|*>`);
        ctx.repos.agentState.setPaused(a1, cmd === 'pause', values.reason);
        ctx.audit.record({ actor: 'human', action: `agent.${cmd}`, target: a1, details: { reason: values.reason } });
        out(`${a1}: ${cmd === 'pause' ? 'paused' : 'resumed'}`);
        if (cmd === 'resume') out(`Ran ${await ctx.queue.drain()} blocked/queued job(s)`);
        break;
      }
      case 'jobs':
        out(ctx.queue.list(values.status as never).map((j) => `${j.id}  ${j.status.padEnd(9)} ${j.type.padEnd(18)} attempts=${j.attempts}/${j.max_attempts}${j.last_error ? `  err=${j.last_error}` : ''}`).join('\n') || 'No jobs');
        break;
      case 'rerun': {
        const n = values.all ? ctx.queue.rerunAllFailed() : a1 && ctx.queue.rerun(a1) ? 1 : 0;
        out(`Re-queued ${n} job(s); ran ${await ctx.queue.drain()}`);
        break;
      }
      case 'costs':
        out({ dryRun: ctx.config.env.DRY_RUN, realSpendUsd: ctx.cost.spentThisMonth(), estimatedInclDryRunUsd: Number(ctx.cost.spentThisMonth({ includeDryRun: true }).toFixed(4)), budgetUsd: ctx.config.env.MONTHLY_BUDGET_USD, byProvider: ctx.cost.summary() });
        break;
      case 'audit':
        out(ctx.audit.recent(Number(values.limit)).map((e) => `${e.created_at}  ${e.actor.padEnd(18)} ${e.action.padEnd(18)} ${e.target ?? ''}`).join('\n'));
        break;
      default:
        out(`Unknown command "${cmd}"\n${HELP}`);
        process.exitCode = 1;
    }
  } finally {
    ctx.close();
  }
}

async function youtubeCommand(cmd: string, clientPath?: string) {
  const root = process.cwd();
  const authPath = resolve(root, YOUTUBE_AUTH_FILE);
  if (cmd === 'youtube:status') {
    const a = loadAuth(authPath);
    if (!a) return out('YouTube غير مربوط. شغّل: npm run cli -- youtube:auth --client <client_secret.json>');
    const yt = new RealYouTube({ tokens: new TokenSource(a), categoryId: '27' });
    const c = await yt.channel();
    return out(`✓ مربوط بقناة: ${c.title} (${c.id}) · مشتركين: ${c.subscribers ?? '?'} · فيديوهات: ${c.videos ?? '?'} · من ${a.savedAt.slice(0, 10)}`);
  }
  if (!clientPath) throw new StudioError('USAGE', 'Usage: youtube:auth --client ~/Downloads/client_secret_XXXX.json');
  const client = readClientJson(clientPath.replace(/^~(?=\/)/, process.env.HOME ?? '~'));
  out('هيتفتح المتصفح على صفحة جوجل. سجّل دخول بحساب القناة ووافق. (عندك 5 دقايق)');
  const tok = await runLoopbackFlow({
    ...client,
    open: (url) => {
      out(`\nلو المتصفح متفتحش، افتح الرابط ده:\n${url}\n`);
      execFile('open', [url], () => {});
    },
  });
  if (tok.missingScopes.length) out(`⚠ صلاحيات ناقصة: ${tok.missingScopes.join(', ')} — بعض المزايا (الصورة المصغّرة/الترجمة/التحليلات) ممكن متشتغلش. أعد الربط ووافق على كل الصلاحيات.`);
  const yt = new RealYouTube({ tokens: new TokenSource({ ...client, refreshToken: tok.refreshToken }), categoryId: '27' });
  const ch = await yt.channel();
  saveAuth(authPath, { ...client, refreshToken: tok.refreshToken, channelId: ch.id, channelTitle: ch.title, savedAt: new Date().toISOString() });
  // Switch the provider on in .env (keys are not touched).
  const envPath = resolve(root, '.env');
  try {
    const env = readFileSync(envPath, 'utf8');
    writeFileSync(envPath, /^YOUTUBE_PROVIDER=/m.test(env) ? env.replace(/^YOUTUBE_PROVIDER=\S*/m, 'YOUTUBE_PROVIDER=real') : env + '\nYOUTUBE_PROVIDER=real\n');
  } catch { /* no .env: user can set YOUTUBE_PROVIDER=real manually */ }
  out(`\n✓ اتربط بقناة: ${ch.title}\n  التصريح محفوظ في ${YOUTUBE_AUTH_FILE} (محمي، ومش بيترفع على git)\n  YOUTUBE_PROVIDER=real اتفعّل. الرفع هيفضل private، والنشر العلني مقفول.`);
}

function writeHtml(ctx: AgentContext, videoId: string) {
  const dir = resolve(ctx.config.rootDir, 'reports/generated');
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${videoId}.html`);
  writeFileSync(path, renderVideoReport(ctx, videoId));
  return path;
}

function printProduce(ctx: AgentContext, r: ProduceResult) {
  for (const s of r.steps) out(`${s.status === 'succeeded' ? '✓' : '✗'} ${s.step}${s.error && s.status !== 'succeeded' ? ` — ${s.error}` : ''}`);
  if (!r.completed) return out(`\nWorkflow halted. Fix the issue, then: npm run cli -- rerun --all`);
  out('\n' + r.message);
  out(`\nVideo: ${r.videoId}\nHTML report: ${writeHtml(ctx, r.videoId)}`);
}

main().catch((err) => {
  process.stderr.write(`✗ ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
