/**
 * The watchdog ("المراقب"): one team member whose only job is hunting problems BEFORE they cost a video. Every
 * cycle it checks the whole pipeline — not only the errors that were thrown — fixes on the spot what is safe to fix
 * automatically, and reports the rest once (Telegram + the error memory, so it is studied and not repeated).
 *
 * Checks: stuck social posts (→ re-encoded + retried), failed GitHub runs (social/bot → re-run), social posting
 * stalled, today's Shorts not produced, YouTube Shorts with no views (locked private?), a Short missing on
 * Facebook/Instagram, motion graphics falling back to stock.
 */
import { writeFileSync, rmSync } from 'node:fs';
import type { AgentContext } from './base.ts';
import { allPosts } from '../analytics/learner.ts';
import { standardMp4, type SocialQueue, type SocialTicket } from '../publishing/social.ts';

export interface Finding { key: string; text: string; fixed?: string }
const H = 3_600_000;

/** Stuck posts (≥ 2 failed tries): the file is re-encoded to the standard format and the tries reset. */
export async function healStuckTickets(q: SocialQueue, tmpDir: string): Promise<Finding[]> {
  const out: Finding[] = [];
  const assets = await q.assets();
  for (const a of assets.filter((x) => x.name.endsWith('.mp4.json'))) {
    const t = JSON.parse((await q.download(a.id)).toString('utf8')) as SocialTicket;
    if (t.tries < 2) continue;
    const v = assets.find((x) => x.name === t.video);
    const f: Finding = { key: `stuck:${t.video}`, text: `منشور واقف: «${t.title}» فشل ${t.tries} مرات (${(t.lastError ?? '').slice(0, 80)})` };
    if (v) {
      try {
        const file = `${tmpDir}/${t.video}`;
        writeFileSync(file, await q.download(v.id));
        await standardMp4(file);
        const { readFileSync } = await import('node:fs');
        await q.remove(v.id); await q.upload(t.video, readFileSync(file), 'video/mp4');
        await q.remove(a.id); await q.upload(a.name, Buffer.from(JSON.stringify({ ...t, tries: 0, lastError: undefined })), 'application/json');
        rmSync(file, { force: true });
        f.fixed = 'اتحوّل للصيغة القياسية واتصفّر عدّاده، وهيتنشر في الدورة الجاية';
      } catch (e) { f.text += ` — التصليح فشل: ${(e as Error).message.slice(0, 80)}`; }
    }
    out.push(f);
  }
  return out;
}

/** Failed GitHub runs in the last 8 h; social/bot ones are re-run once (safe: they never post twice). */
export async function checkRuns(repo: string, token: string, now = new Date(), fetchImpl: typeof fetch = fetch): Promise<Finding[]> {
  const h = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' };
  const r = await fetchImpl(`https://api.github.com/repos/${repo}/actions/runs?per_page=40&created=>${new Date(now.getTime() - 8 * H).toISOString()}`, { headers: h });
  if (!r.ok) return [];
  const runs = ((await r.json()) as { workflow_runs: { id: number; name: string; conclusion: string | null; created_at: string; run_attempt: number }[] }).workflow_runs;
  const out: Finding[] = [];
  // Manual diagnostic workflows (check-keys, motion-check) are tests, not the pipeline.
  for (const run of runs.filter((x) => ['failure', 'startup_failure', 'timed_out'].includes(x.conclusion ?? '') && !['check-keys', 'motion-check'].includes(x.name))) {
    const f: Finding = { key: `run:${run.id}`, text: `تشغيل ${run.name} فشل (${run.conclusion}) الساعة ${run.created_at.slice(11, 16)} UTC` };
    if (['social', 'bot'].includes(run.name) && run.run_attempt < 2) {
      const rr = await fetchImpl(`https://api.github.com/repos/${repo}/actions/runs/${run.id}/rerun-failed-jobs`, { method: 'POST', headers: h }).catch(() => undefined);
      if (rr?.ok) f.fixed = 'اتعاد تشغيله';
    }
    out.push(f);
  }
  // Social posting stalled: no successful social run for 3 h during posting hours (05–21 UTC).
  const lastSocial = runs.filter((x) => x.name === 'social' && x.conclusion === 'success').map((x) => x.created_at).sort().at(-1);
  const hr = now.getUTCHours();
  if (hr >= 8 && hr <= 21 && (!lastSocial || now.getTime() - new Date(lastSocial).getTime() > 3 * H)) out.push({ key: `social-stalled:${now.toISOString().slice(0, 13)}`, text: 'النشر على فيسبوك وإنستجرام ما اشتغلش بنجاح من أكتر من 3 ساعات' });
  return out;
}

/** Checks on our own records (no network). */
export function checkRecords(ctx: AgentContext, now = new Date(), pendingTitles: string[] = []): Finding[] {
  const out: Finding[] = [];
  const today = now.toISOString().slice(0, 10);
  // Today's Shorts not produced by 20:00 Cairo.
  const renderedToday = ctx.repos.artifacts.listKind('render').some((a) => a.created_at.slice(0, 10) === today);
  if (now.getUTCHours() >= 18 && !renderedToday) out.push({ key: `no-pack:${today}`, text: 'فيديوهات النهارده لسه ما اتعملتش لحد الساعة 8 بالليل' });
  const posts = allPosts(ctx);
  for (const p of posts.filter((x) => x.platform === 'youtube')) {
    const age = now.getTime() - new Date(p.publish_at).getTime();
    // A YouTube Short with 0 views a day later: usually stuck private (API audit) or blocked.
    if (age > 30 * H && age < 4 * 24 * H && p.metrics.h24 && p.metrics.h24.views === 0) out.push({ key: `yt-zero:${p.external_id}`, text: `«${p.title}» على يوتيوب عنده 0 مشاهدة بعد يوم — ممكن يكون مقفول private أو محجوب` });
    // Missing on Facebook / Instagram 8 h after it went up on YouTube (and not waiting in the queue).
    if (age > 8 * H && age < 3 * 24 * H && p.video_id && p.secret_id) {
      for (const pl of ['facebook', 'instagram'] as const) {
        const there = posts.some((x) => x.platform === pl && (x.secret_id === p.secret_id || x.title === p.title));
        const waiting = pendingTitles.some((t) => t && p.title && (t.includes(p.title.slice(0, 15)) || p.title.includes(t.slice(0, 15))));
        if (!there && !waiting) out.push({ key: `missing:${pl}:${p.external_id}`, text: `«${p.title}» نزل على يوتيوب ومش موجود على ${pl === 'facebook' ? 'فيسبوك' : 'إنستجرام'}` });
      }
    }
  }
  // Motion graphics falling back to stock footage (owner chose 100% motion).
  const fails = ctx.repos.artifacts.listKind<{ error: string }>('motion_failure').filter((a) => now.getTime() - new Date(a.created_at).getTime() < 48 * H);
  if (fails.length >= 2) out.push({ key: `motion-fallback:${today}`, text: `الموشن فشل ${fails.length} مرات في آخر يومين ونزل بلقطات بدل منه (${fails.at(-1)!.data.error.slice(0, 80)})` });
  return out;
}

/** New findings only (each reported once), remembered for 14 days. */
export function newFindings(ctx: AgentContext, all: Finding[], now = new Date()): Finding[] {
  const seen = ctx.repos.artifacts.latest<{ keys: Record<string, string> }>(null, 'watchdog_seen')?.data.keys ?? {};
  const fresh = all.filter((f) => !seen[f.key]);
  const keep = Object.fromEntries(Object.entries(seen).filter(([, at]) => now.getTime() - new Date(at).getTime() < 14 * 24 * H));
  for (const f of fresh) keep[f.key] = now.toISOString();
  if (fresh.length) ctx.repos.artifacts.save({ videoId: null, kind: 'watchdog_seen', agent: 'watchdog', data: { keys: keep } });
  return fresh;
}

/** Telegram message for the owner. */
export function watchdogMessage(fs: Finding[]): string | undefined {
  if (!fs.length) return undefined;
  const fixed = fs.filter((f) => f.fixed), open = fs.filter((f) => !f.fixed);
  return ['🛡️ المراقب:', ...fixed.map((f) => `🔧 ${f.text}\n   ← صلّحته: ${f.fixed}`), ...open.map((f) => `⚠️ ${f.text}`), ...(open.length ? ['', 'اللي محتاج تعديل في الكود: قولّي «صلّح» في الشات.'] : [])].join('\n');
}

/** Titles of the posts still waiting in the social queue (so "missing on Facebook" ignores scheduled ones). */
export async function pendingTitles(q: SocialQueue): Promise<string[]> {
  const out: string[] = [];
  for (const a of (await q.assets()).filter((x) => x.name.endsWith('.mp4.json'))) out.push(((JSON.parse((await q.download(a.id)).toString('utf8')) as SocialTicket).title) ?? '');
  return out;
}
