/**
 * Keeps the Telegram assistant (bot/worker.js) up to date, hourly: a live report (followers, views, likes per
 * platform), the list of recent / scheduled Shorts with their Telegram file_ids, and alerts when a Short
 * takes off. The Worker answers "تقرير" / "فيديو" instantly from this data.
 */
import type { AgentContext } from '../agents/base.ts';
import { allPosts, type Post } from '../analytics/learner.ts';
import { cairoTime } from './telegram.ts';

export interface LiveStats {
  youtubeVideos?: (ids: string[]) => Promise<Record<string, { views: number; likes: number; comments: number }>>;
  youtubeChannel?: () => Promise<{ subscribers: number; views: number }>;
  facebook?: (id: string) => Promise<{ views: number; likes?: number; comments?: number }>;
  instagram?: (id: string) => Promise<{ views: number; likes?: number; comments?: number; saves?: number; shares?: number }>;
  followers?: () => Promise<{ facebook?: number; instagram?: number }>;
}
export interface TgVideo { title: string; file_id?: string; publishAt?: string; blocked?: string }
interface Live { post: Post; views: number; likes: number }

const ICON: Record<string, string> = { youtube: '▶️', facebook: '📘', instagram: '📸' };
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : 0; };

/** Live numbers for every post of the last `days` days (pure apart from the injected fetchers). */
export async function liveNumbers(posts: Post[], src: LiveStats, now: Date, days = 7): Promise<Live[]> {
  const recent = posts.filter((p) => new Date(p.publish_at) <= now && now.getTime() - new Date(p.publish_at).getTime() < days * 86_400_000);
  const out: Live[] = [];
  const yt = recent.filter((p) => p.platform === 'youtube');
  const ys = yt.length && src.youtubeVideos ? await src.youtubeVideos(yt.map((p) => p.external_id)).catch(() => ({} as Record<string, { views: number; likes: number }>)) : {};
  for (const p of yt) if (ys[p.external_id]) out.push({ post: p, views: ys[p.external_id]!.views, likes: ys[p.external_id]!.likes });
  for (const p of recent.filter((x) => x.platform !== 'youtube')) {
    const f = p.platform === 'facebook' ? src.facebook : src.instagram;
    const s = f ? await f(p.external_id).catch(() => undefined) : undefined;
    if (s) out.push({ post: p, views: s.views, likes: s.likes ?? 0 });
  }
  return out;
}

/** A post "takes off" when it beats both an absolute floor and 4× its platform's usual 24 h views. */
export function viralAlerts(live: Live[], history: Post[], now: Date): { id: string; text: string }[] {
  const out: { id: string; text: string }[] = [];
  for (const l of live) {
    const ageH = (now.getTime() - new Date(l.post.publish_at).getTime()) / 3_600_000;
    if (ageH > 72) continue;
    const base = median(history.filter((p) => p.platform === l.post.platform && p.metrics.h24).map((p) => p.metrics.h24!.views));
    const bar = Math.max(300, base * 4);
    if (l.views < bar) continue;
    // One alert per milestone: 300 → 1k → 5k → 20k → 100k …
    const tier = [300, 1000, 5000, 20000, 100000, 500000].filter((t) => l.views >= t).pop() ?? 300;
    const times = base ? ` (${Math.round(l.views / Math.max(1, base))}× المعتاد)` : '';
    out.push({ id: `${l.post.id}:${tier}`, text: `🔥 فيديو بيضرب!\n${l.post.title?.replace(/\s*#Shorts$/, '')}\n${ICON[l.post.platform]} ${l.views.toLocaleString('en')} مشاهدة في ${Math.max(1, Math.round(ageH))} ساعة${times}\n👍 ${l.likes} لايك` });
  }
  return out;
}

/** Report text for "تقرير". */
export function liveReport(live: Live[], followers: { youtube?: number; facebook?: number; instagram?: number }): string {
  const lines = ['📊 تقرير سر الموبايل', ''];
  lines.push(`👥 المتابعين:  ▶️ ${followers.youtube ?? '—'}   📘 ${followers.facebook ?? '—'}   📸 ${followers.instagram ?? '—'}`, '');
  const by = new Map<string, Live[]>();
  for (const l of live) { const k = (l.post.title ?? '').replace(/\s*#Shorts$/, ''); by.set(k, [...(by.get(k) ?? []), l]); }
  const sorted = [...by].sort((a, b) => (b[1][0]!.post.publish_at).localeCompare(a[1][0]!.post.publish_at)).slice(0, 10);
  for (const [title, ls] of sorted) {
    lines.push(`• ${title}`, `   ${ls.sort((a, b) => a.post.platform.localeCompare(b.post.platform)).map((l) => `${ICON[l.post.platform]} ${l.views} 👁  ${l.likes} 👍`).join('   ')}`);
  }
  if (!live.length) lines.push('لسه مفيش أرقام — أول منشورات بتتقاس خلال ساعة من نشرها.');
  const tot = (pl: string, k: 'views' | 'likes') => live.filter((l) => l.post.platform === pl).reduce((a, l) => a + l[k], 0);
  lines.push('', `الإجمالي (آخر 7 أيام):`);
  for (const pl of ['youtube', 'facebook', 'instagram']) lines.push(`   ${ICON[pl]} ${tot(pl, 'views')} مشاهدة · ${tot(pl, 'likes')} لايك`);
  const best = [...by].map(([t, ls]) => ({ t, v: ls.reduce((a, l) => a + l.views, 0) })).sort((a, b) => b.v - a.v)[0];
  if (best && best.v > 0) lines.push('', `🏆 الأقوى: ${best.t} (${best.v} مشاهدة على كل المنصات)`);
  return lines.join('\n');
}

/** Video list for "فيديو": recent productions' Shorts with status and Telegram file_id. */
export function videoList(ctx: AgentContext, now: Date): { title: string; status: string; icon: string; file_id?: string }[] {
  const items: { title: string; status: string; icon: string; file_id?: string; at: string }[] = [];
  for (const a of ctx.repos.artifacts.listKind<{ shorts: TgVideo[] }>('telegram_videos')) {
    if (now.getTime() - new Date(a.created_at).getTime() > 4 * 86_400_000) continue;
    for (const v of a.data.shorts) {
      const future = v.publishAt && new Date(v.publishAt) > now;
      items.push({
        title: v.title, file_id: v.file_id, at: v.publishAt ?? a.created_at,
        icon: v.blocked ? '⛔' : future ? '⏰' : '✅',
        status: v.blocked ? `اتوقف: ${v.blocked.slice(0, 80)}` : future ? `هينزل ${cairoTime(v.publishAt, now)}` : `نزل ${cairoTime(v.publishAt ?? a.created_at, now)}`,
      });
    }
  }
  // Scheduled first (soonest first), then the newest published.
  return items.sort((a, b) => Number(b.icon === '⏰') - Number(a.icon === '⏰') || (a.icon === '⏰' ? a.at.localeCompare(b.at) : b.at.localeCompare(a.at))).map(({ at: _, ...x }) => x);
}

/** Builds everything and pushes it to the Worker. No-op without BOT_URL / BOT_INGEST_SECRET. */
export async function syncBot(ctx: AgentContext, src: LiveStats, now = new Date(), extra: { messages?: string[] } = {}): Promise<string> {
  const url = process.env.BOT_URL, secret = process.env.BOT_INGEST_SECRET;
  if (!url || !secret) return 'bot not connected';
  const posts = allPosts(ctx);
  const live = await liveNumbers(posts, src, now);
  const [yc, fol] = await Promise.all([src.youtubeChannel?.().catch(() => undefined), src.followers?.().catch(() => undefined)]);
  const body = {
    report: liveReport(live, { youtube: yc?.subscribers, facebook: fol?.facebook, instagram: fol?.instagram }),
    reportAt: cairoTime(now.toISOString(), now),
    videos: videoList(ctx, now),
    alerts: viralAlerts(live, posts, now),
    messages: extra.messages ?? [],
  };
  const res = await fetch(`${url.replace(/\/$/, '')}/ingest`, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return `bot sync: HTTP ${res.status}, ${live.length} live numbers, ${body.videos.length} videos, ${body.alerts.length} alert candidates`;
}
