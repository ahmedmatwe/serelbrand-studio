/**
 * Weekly report for the owner (Telegram, Fridays from 21:00 Cairo): this week vs last week per platform, the best
 * and weakest Shorts, motion graphics vs stock footage, trend Shorts, what the team learned, and the road to
 * YouTube monetisation (1,000 subscribers + 10M Shorts views in 90 days).
 */
import type { AgentContext } from '../agents/base.ts';
import { allPosts, type Post } from '../analytics/learner.ts';
import { buildPerformance } from '../analytics/analyst.ts';
import { z } from 'zod';
import { labSummary } from '../lab/lab.ts';
import { errorSummary } from '../lab/errors.ts';

const NAME: Record<string, string> = { youtube: '▶️ يوتيوب', facebook: '📘 فيسبوك', instagram: '📸 إنستجرام', tiktok: '🎵 تيك توك' };
const views = (p: Post) => p.metrics.h72?.views ?? p.metrics.h24?.views ?? 0;
const fmt = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(1)}K` : String(Math.round(n)));
const pct = (a: number, b: number) => (b > 0 ? `${a >= b ? '↑' : '↓'} ${Math.abs(Math.round(((a - b) / b) * 100))}%` : '');

/** The weekly report with the team's lessons (written in English for the agents) put into Egyptian Arabic. */
export async function weeklyReportArabic(ctx: AgentContext, now = new Date(), subscribers?: number): Promise<string> {
  const text = weeklyReport(ctx, now, subscribers);
  const m = text.match(/🧠 الفريق اتعلم الأسبوع ده:\n((?:- .*\n?)+)/);
  if (!m || ctx.providers.llm.name.startsWith('mock')) return text;
  const lines = m[1]!.trim().split('\n').map((l) => l.replace(/^- /, ''));
  const r = await ctx.providers.llm.generateJson({
    task: 'report.translate', tier: 'light',
    system: 'Rewrite each line in short, simple Egyptian Arabic for the channel owner (≤ 20 words each, same meaning, no jargon). JSON only.',
    prompt: JSON.stringify({ lines }),
    schema: z.object({ lines: z.array(z.string()) }),
    maxOutputTokens: 1200,
  }).catch(() => undefined);
  const ar = (r?.data as { lines: string[] } | undefined)?.lines;
  return ar?.length === lines.length ? text.replace(m[1]!, ar.map((l) => `- ${l}`).join('\n') + '\n') : text;
}

export function weeklyReport(ctx: AgentContext, now = new Date(), subscribers?: number): string {
  const posts = allPosts(ctx).filter((p) => new Date(p.publish_at) <= now);
  const inWeek = (p: Post, w: number) => { const age = now.getTime() - new Date(p.publish_at).getTime(); return age >= w * 7 * 86_400_000 && age < (w + 1) * 7 * 86_400_000; };
  const lines = ['📅 تقرير سر الموبايل الأسبوعي', ''];
  const thisW = posts.filter((p) => inWeek(p, 0)), lastW = posts.filter((p) => inWeek(p, 1));
  const titles = new Set(thisW.map((p) => (p.title ?? '').replace(/\s*#Shorts$/, '')));
  lines.push(`🎬 اتنشر ${titles.size} فيديو الأسبوع ده`);
  for (const pl of ['youtube', 'facebook', 'instagram']) {
    const a = thisW.filter((p) => p.platform === pl).reduce((s, p) => s + views(p), 0), b = lastW.filter((p) => p.platform === pl).reduce((s, p) => s + views(p), 0);
    if (a || b) lines.push(`${NAME[pl]}: ${fmt(a)} مشاهدة ${pct(a, b)}`);
  }
  const perf = buildPerformance(ctx, posts, now).filter((s) => s.results.length);
  const score = (s: (typeof perf)[number]) => s.results.reduce((x, r) => x + r.vsPlatformUsual, 0) / s.results.length;
  const ranked = [...perf].sort((a, b) => score(b) - score(a));
  if (ranked.length) {
    lines.push('', '🏆 الأقوى:', ...ranked.slice(0, 3).map((s) => `• ${s.title} (×${score(s).toFixed(1)} من المعتاد)`));
    if (ranked.length > 3) lines.push(`🔻 الأضعف: ${ranked.at(-1)!.title} (×${score(ranked.at(-1)!).toFixed(1)})`);
  }
  const avg = (xs: typeof perf) => (xs.length ? xs.reduce((a, s) => a + score(s), 0) / xs.length : undefined);
  const mo = avg(perf.filter((s) => s.look === 'motion')), st = avg(perf.filter((s) => s.look === 'stock'));
  if (mo !== undefined && st !== undefined) lines.push('', `🎨 الموشن جرافيك ×${mo.toFixed(1)} · اللقطات الجاهزة ×${st.toFixed(1)} — ${mo > st * 1.1 ? 'الموشن كسبان' : st > mo * 1.1 ? 'اللقطات كسبانة' : 'متقاربين'}`);
  const tr = perf.filter((s) => s.trend);
  if (tr.length) lines.push(`📈 فيديوهات التريند: ${tr.length} — متوسط ×${avg(tr)!.toFixed(1)} من المعتاد`);
  const week = now.getTime() - 7 * 86_400_000;
  const learned = ctx.repos.knowledge.byCategory('lesson').filter((k) => k.confidence * 1e13 > week).slice(0, 4);
  if (learned.length) lines.push('', '🧠 الفريق اتعلم الأسبوع ده:', ...learned.map((k) => `- ${k.insight.replace(/^Performance \([^)]*\):\s*/, '').slice(0, 140)}`));
  // The lab (live experiments) and the error memory.
  const lab = labSummary(ctx, now);
  if (lab.length) lines.push('', '🧪 التجارب الشغالة (×المشاهدات من المعتاد، وعدد الفيديوهات):', ...lab);
  const errs = errorSummary(ctx, now);
  if (errs.length) lines.push('', '🧯 الأخطاء اللي اتكررت:', ...errs);
  // Monetisation (Shorts path): 1,000 subscribers + 10M Shorts views in the last 90 days.
  const v90 = posts.filter((p) => p.platform === 'youtube' && now.getTime() - new Date(p.publish_at).getTime() < 90 * 86_400_000).reduce((s, p) => s + views(p), 0);
  lines.push('', '💰 الطريق لأرباح يوتيوب:', `- المشتركين: ${subscribers ?? '؟'} / 1000`, `- مشاهدات الشورتس آخر 90 يوم: ${fmt(v90)} / 10M`);
  return lines.join('\n');
}
