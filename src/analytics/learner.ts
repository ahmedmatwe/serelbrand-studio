/**
 * The channel's learning loop — every cycle:
 *  1. MEASURE every post on every platform (YouTube, Facebook, Instagram) 24 h and 72 h after it went public.
 *  2. SCORE each post against the channel's own recent normal (log of views ÷ recent median on that platform),
 *     so growth over time doesn't fool the comparison.
 *  3. LEARN the best publishing hours with a UCB bandit: proven hours are kept, untested hours keep getting a
 *     fair trial (that is how a better time is discovered — fixed times can never improve).
 *  4. LEARN which kind of secret people watch (code / iPhone / Android) and weight tomorrow's picks.
 *  5. DETECT problems (viewers leave early, a platform gets nothing, posts failing) and ADAPT (e.g. shorter
 *     Shorts when retention drops), writing every decision with its evidence to the knowledge base.
 * Pure functions are exported for tests; `runLearning` wires them to the database and the platforms.
 */
import type { AgentContext } from '../agents/base.ts';

export type Platform = 'youtube' | 'facebook' | 'instagram';
export interface PostMetrics { views: number; likes?: number; comments?: number; shares?: number; avgPercentViewed?: number }
export interface Post { id: string; platform: Platform; external_id: string; video_id?: string | null; secret_id?: string | null; family?: string | null; title?: string | null; publish_at: string; metrics: { h24?: PostMetrics; h72?: PostMetrics } }

/** Candidate publishing hours (UTC 05–20 = 07:00–22:00 Cairo). */
export const CANDIDATE_HOURS = Array.from({ length: 16 }, (_, i) => i + 5);
export const DEFAULT_SHORT_HOURS = [11, 15, 18];
/**
 * Starting hours per platform (UTC; Cairo = +2) before there is data: YouTube 1/5/8 pm, Facebook 12/5/9 pm
 * (evening scroll after work), Instagram 11 am/4/8 pm. The learner replaces each with what that platform's
 * own numbers prove.
 */
export const PLATFORM_DEFAULT_HOURS: Record<Platform, number[]> = { youtube: [11, 15, 18], facebook: [10, 15, 19], instagram: [9, 14, 18] };

// ------------------------------------------------------------------ registry
export function registerPost(ctx: AgentContext, p: Omit<Post, 'id' | 'metrics'>) {
  const id = `${p.platform}:${p.external_id}`;
  (ctx as unknown as { db: { run: (s: string, a: unknown[]) => void } }).db.run(
    `INSERT INTO posts (id, platform, external_id, video_id, secret_id, family, title, publish_at, metrics, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?) ON CONFLICT(id) DO UPDATE SET publish_at = excluded.publish_at`,
    [id, p.platform, p.external_id, p.video_id ?? null, p.secret_id ?? null, p.family ?? null, p.title ?? null, p.publish_at, new Date().toISOString()],
  );
}
function db(ctx: AgentContext) { return (ctx as unknown as { db: { run: (s: string, a?: unknown[]) => void; all: <T>(s: string, a?: unknown[]) => T[] } }).db; }
export function allPosts(ctx: AgentContext): Post[] {
  return db(ctx).all<Omit<Post, 'metrics'> & { metrics: string }>('SELECT * FROM posts ORDER BY publish_at').map((r) => ({ ...r, metrics: JSON.parse(r.metrics || '{}') }));
}
function saveMetrics(ctx: AgentContext, p: Post) {
  db(ctx).run('UPDATE posts SET metrics = ?, updated_at = ? WHERE id = ?', [JSON.stringify(p.metrics), new Date().toISOString(), p.id]);
}

// ------------------------------------------------------------------ scoring (pure)
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : 0; };

/** log(views ÷ median of the previous 14 measured posts on the same platform): 0 = normal, +0.7 ≈ double. */
export function scorePosts(posts: Post[]): { post: Post; score: number }[] {
  const out: { post: Post; score: number }[] = [];
  const byPlat = new Map<string, Post[]>();
  for (const p of posts.filter((x) => x.metrics.h24).sort((a, b) => a.publish_at.localeCompare(b.publish_at))) {
    const prev = byPlat.get(p.platform) ?? [];
    const base = prev.length ? median(prev.slice(-14).map((x) => x.metrics.h24!.views)) : p.metrics.h24!.views;
    out.push({ post: p, score: Math.log((p.metrics.h24!.views + 1) / (base + 1)) });
    byPlat.set(p.platform, [...prev, p]);
  }
  return out;
}

/**
 * Picks `count` daily hours (≥ minGap apart) by Upper Confidence Bound over hour scores. Untested hours get a
 * big bonus (they must be tried), the default hours start with a small prior so day one is sensible.
 */
export function chooseHours(scored: { post: Post; score: number }[], count = 3, minGap = 3, c = 0.6, defaults = DEFAULT_SHORT_HOURS): { hours: number[]; table: { h: number; n: number; mean: number; ucb: number }[] } {
  const stats = new Map<number, { n: number; sum: number }>();
  for (const h of CANDIDATE_HOURS) stats.set(h, defaults.includes(h) ? { n: 2, sum: 0.2 } : { n: 0, sum: 0 });
  for (const { post, score } of scored) {
    const h = new Date(post.publish_at).getUTCHours();
    const s = stats.get(h);
    if (s) { s.n++; s.sum += score; }
  }
  const total = [...stats.values()].reduce((a, s) => a + s.n, 0) + 1;
  const table = CANDIDATE_HOURS.map((h) => {
    const s = stats.get(h)!;
    const mean = s.n ? s.sum / s.n : 0;
    return { h, n: s.n, mean, ucb: mean + c * Math.sqrt(Math.log(total) / (s.n + 1)) };
  }).sort((a, b) => b.ucb - a.ucb || a.h - b.h);
  if (!scored.length) return { hours: [...defaults], table };
  // Exploit: the best proven hours (by mean, defaults carry a small prior) for all slots but one;
  // explore: the last slot goes to the highest-UCB hour not yet chosen (an untested hour gets its trial).
  const hours: number[] = [];
  const fits = (h: number) => hours.every((x) => Math.abs(x - h) >= minGap);
  for (const row of [...table].filter((r) => r.n > 0).sort((a, b) => b.mean - a.mean || a.h - b.h)) {
    if (hours.length >= count - 1) break;
    if (fits(row.h)) hours.push(row.h);
  }
  for (const row of table) { if (hours.length >= count) break; if (fits(row.h)) hours.push(row.h); }
  return { hours: hours.sort((a, b) => a - b), table };
}

/** Relative appetite per secret family (code / ios / android): exp(mean score), clamped 0.5–2, prior 1. */
export function familyWeights(scored: { post: Post; score: number }[]): Record<string, number> {
  const by = new Map<string, number[]>();
  for (const { post, score } of scored) if (post.family) by.set(post.family, [...(by.get(post.family) ?? []), score]);
  const w: Record<string, number> = { apps: 1, code: 1, ios: 1, android: 1 };
  for (const [f, xs] of by) {
    const shrink = xs.length / (xs.length + 4); // few posts → stay near 1
    w[f] = Math.min(2, Math.max(0.5, Math.exp(shrink * (xs.reduce((a, b) => a + b, 0) / xs.length))));
  }
  return w;
}

/**
 * Shorts length that keeps people watching: from YouTube average-percent-viewed of the last 6 Shorts.
 * Low retention → shorter (−10 words), very high → a bit longer (+5), within 55–100 words.
 */
export function adaptLength(posts: Post[], current: number): { words: number; reason?: string } {
  const r = posts.filter((p) => p.platform === 'youtube' && p.metrics.h72?.avgPercentViewed !== undefined).slice(-6).map((p) => p.metrics.h72!.avgPercentViewed!);
  if (r.length < 4) return { words: current };
  const m = median(r);
  if (m < 0.55) return { words: Math.max(55, current - 10), reason: `viewers watch only ${Math.round(m * 100)}% of a Short on average → Shorts shortened to ${Math.max(55, current - 10)} words` };
  if (m > 0.85) return { words: Math.min(100, current + 5), reason: `viewers watch ${Math.round(m * 100)}% on average → room for a bit more detail (${Math.min(100, current + 5)} words)` };
  return { words: current };
}

/** Problems worth a human's attention (pure). */
export function detectProblems(posts: Post[], scored: { post: Post; score: number }[]): string[] {
  const out: string[] = [];
  for (const plat of ['youtube', 'facebook', 'instagram'] as const) {
    const recent = posts.filter((p) => p.platform === plat && p.metrics.h24).slice(-6);
    if (recent.length >= 4 && recent.every((p) => p.metrics.h24!.views === 0)) out.push(`${plat}: آخر ${recent.length} منشورات جابت 0 مشاهدة — غالباً مشكلة في النشر أو الحساب محظور/مقيّد`);
  }
  const low = posts.filter((p) => p.platform === 'youtube' && (p.metrics.h72?.avgPercentViewed ?? 1) < 0.4).slice(-3);
  for (const p of low) out.push(`"${p.title}": الناس بتمشي بدري (${Math.round(p.metrics.h72!.avgPercentViewed! * 100)}% بس من الشورت) — البداية محتاجة تبقى أقوى`);
  const worst = scored.filter((s) => s.score < -1.2).slice(-3);
  for (const s of worst) out.push(`"${s.post.title}" على ${s.post.platform}: أقل من ثلث المعتاد`);
  return out;
}

// ------------------------------------------------------------------ knowledge helpers
export function readKnowledge(ctx: AgentContext, prefix: string): string | undefined {
  return ctx.repos.knowledge.byCategory('learning').find((k) => k.insight.startsWith(prefix))?.insight.slice(prefix.length);
}
function writeKnowledge(ctx: AgentContext, prefix: string, value: string, evidence: string, n: number) {
  if (readKnowledge(ctx, prefix) === value) return false;
  // Newest wins: confidence encodes recency so byCategory (sorted by confidence) returns it first.
  ctx.repos.knowledge.add({ category: 'learning', insight: `${prefix}${value}`, evidence, confidence: Date.now() / 1e13, sampleSize: n });
  return true;
}
export const learnedFamilyWeights = (ctx: AgentContext): Record<string, number> | undefined => { const v = readKnowledge(ctx, 'family_weights='); return v ? JSON.parse(v) : undefined; };
export const learnedShortWords = (ctx: AgentContext): number | undefined => { const v = readKnowledge(ctx, 'short_target_words='); return v ? Number(v) : undefined; };
export const learnedShortHours = (ctx: AgentContext): number[] | undefined => { const v = readKnowledge(ctx, 'short_utc_hours='); return v ? v.split(',').map(Number) : undefined; };
/** Current best Shorts hours (UTC) for one platform: learned from its own posts, else its starting hours. */
export function platformHours(ctx: AgentContext, pl: Platform): number[] {
  const v = readKnowledge(ctx, pl === 'youtube' ? 'short_utc_hours=' : `short_utc_hours:${pl}=`);
  const h = v?.split(',').map(Number).filter((x) => x >= 0 && x < 24);
  return h?.length ? h : [...PLATFORM_DEFAULT_HOURS[pl]];
}
/**
 * When Short number `i` of a day goes out on a platform: that platform's i-th best hour on the same day as its
 * YouTube slot. Never in the past (then it follows YouTube's time).
 */
export function platformTime(hours: number[], youtubeAt: string, i: number, now = new Date()): string {
  const sorted = [...new Set(hours)].sort((a, b) => a - b);
  if (!sorted.length) return youtubeAt;
  const d = new Date(youtubeAt);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), sorted[i % sorted.length]!));
  return t.getTime() - now.getTime() >= 10 * 60_000 ? t.toISOString() : youtubeAt;
}

// ------------------------------------------------------------------ the loop
export interface MetricsSource {
  youtube?: (ids: string[]) => Promise<Record<string, PostMetrics>>;
  youtubeRetention?: (id: string) => Promise<number | undefined>;
  facebook?: (id: string) => Promise<PostMetrics>;
  instagram?: (id: string) => Promise<PostMetrics>;
}

/** Measures due posts, then learns hours / content / length and detects problems. Returns report lines (Arabic). */
export async function runLearning(ctx: AgentContext, src: MetricsSource, now = new Date()): Promise<string[]> {
  const log: string[] = [];
  const posts = allPosts(ctx);
  const age = (p: Post) => (now.getTime() - new Date(p.publish_at).getTime()) / 3_600_000;
  // 1) Measure (24 h and 72 h checkpoints; a checkpoint missed by days is still taken, marked by its age).
  const due = (cp: 'h24' | 'h72', hours: number) => posts.filter((p) => !p.metrics[cp] && age(p) >= hours && age(p) < 24 * 30);
  for (const cp of ['h24', 'h72'] as const) {
    const list = due(cp, cp === 'h24' ? 24 : 72);
    const yt = list.filter((p) => p.platform === 'youtube');
    if (yt.length && src.youtube) {
      const stats = await src.youtube(yt.map((p) => p.external_id)).catch(() => ({} as Record<string, PostMetrics>));
      for (const p of yt) {
        const m = stats[p.external_id];
        if (!m) continue;
        if (cp === 'h72' && src.youtubeRetention) m.avgPercentViewed = await src.youtubeRetention(p.external_id).catch(() => undefined);
        p.metrics[cp] = m; saveMetrics(ctx, p);
      }
    }
    for (const p of list.filter((x) => x.platform !== 'youtube')) {
      const f = p.platform === 'facebook' ? src.facebook : src.instagram;
      if (!f) continue;
      try { p.metrics[cp] = await f(p.external_id); saveMetrics(ctx, p); } catch (err) { log.push(`⚠️ قياس ${p.platform} "${p.title}" فشل: ${(err as Error).message.slice(0, 120)}`); }
    }
  }
  // 2–5) Learn.
  const scored = scorePosts(posts);
  if (!scored.length) return log;
  // Each platform gets its own best hours, learned from that platform's own numbers only (people scroll
  // Facebook, Instagram and YouTube at different times). YouTube's plan keeps the old key the scheduler reads.
  const cairo = (h: number) => `${(h + 2) % 24}:00`;
  const NAME: Record<Platform, string> = { youtube: '▶️ يوتيوب', facebook: '📘 فيسبوك', instagram: '📸 إنستجرام' };
  for (const pl of ['youtube', 'facebook', 'instagram'] as Platform[]) {
    const own = scored.filter((x) => x.post.platform === pl);
    if (!own.length) continue;
    const { hours, table } = chooseHours(own, 3, 3, 0.6, PLATFORM_DEFAULT_HOURS[pl]);
    const key = pl === 'youtube' ? 'short_utc_hours=' : `short_utc_hours:${pl}=`;
    if (writeKnowledge(ctx, key, hours.join(','), table.slice(0, 6).map((r) => `${cairo(r.h)} n=${r.n} mean=${r.mean.toFixed(2)}`).join('; '), own.length)) {
      log.push(`🕒 ${NAME[pl]} — مواعيد النشر الجاية (بتوقيت القاهرة): ${hours.map(cairo).join(' و ')} — من ${own.length} منشور عليه (وبنجرّب مواعيد جديدة كمان)`);
    }
  }
  const w = familyWeights(scored);
  if (writeKnowledge(ctx, 'family_weights=', JSON.stringify(Object.fromEntries(Object.entries(w).map(([k, v]) => [k, Number(v.toFixed(2))]))), `${scored.length} scored posts`, scored.length)) {
    const name: Record<string, string> = { apps: 'أسرار التطبيقات (واتساب/إنستجرام/تيك توك…)', code: 'الأكواد', ios: 'أسرار الآيفون', android: 'أسرار الأندرويد' };
    const best = Object.entries(w).sort((a, b) => b[1] - a[1])[0]!;
    if (best[1] > 1.15) log.push(`📈 ${name[best[0]] ?? best[0]} بتجيب مشاهدات أكتر — هتاخد نصيب أكبر من الأيام الجاية`);
  }
  const words = adaptLength(posts, learnedShortWords(ctx) ?? 85);
  if (words.reason && writeKnowledge(ctx, 'short_target_words=', String(words.words), words.reason, posts.length)) log.push(`✂️ ${words.reason}`);
  for (const p of detectProblems(posts, scored)) log.push(`⚠️ ${p}`);
  return log;
}

/**
 * Daily report for the owner (Arabic, plain text): every Short of the last 3 days with its views on each
 * platform, today's best one, totals per platform, and the team's current decisions.
 */
export function dailyReport(ctx: AgentContext, now = new Date()): string {
  const posts = allPosts(ctx).filter((p) => now.getTime() - new Date(p.publish_at).getTime() < 3 * 86_400_000 && new Date(p.publish_at) <= now);
  const icon: Record<string, string> = { youtube: '▶️ يوتيوب', facebook: '📘 فيسبوك', instagram: '📸 إنستجرام' };
  const views = (p: Post) => p.metrics.h72?.views ?? p.metrics.h24?.views;
  const byTitle = new Map<string, Post[]>();
  for (const p of posts) { const k = (p.title ?? '').replace(/\s*#Shorts$/, ''); byTitle.set(k, [...(byTitle.get(k) ?? []), p]); }
  const lines = ['📊 تقرير سر الموبايل اليومي', ''];
  const totals: Record<string, number> = {};
  let best: { title: string; v: number } | undefined;
  for (const [title, ps] of byTitle) {
    const parts = ps.sort((a, b) => a.platform.localeCompare(b.platform)).map((p) => { const v = views(p); if (v !== undefined) totals[p.platform] = (totals[p.platform] ?? 0) + v; return `${icon[p.platform]} ${v ?? '⏳'}`; });
    const sum = ps.reduce((a, p) => a + (views(p) ?? 0), 0);
    if (!best || sum > best.v) best = { title, v: sum };
    lines.push(`• ${title}`, `   ${parts.join('   ')}`);
  }
  if (!byTitle.size) lines.push('لسه مفيش منشورات في آخر 3 أيام.');
  lines.push('', `الإجمالي: ${Object.entries(totals).map(([k, v]) => `${icon[k]} ${v}`).join('   ') || '⏳ القياس الأول بعد 24 ساعة من النشر'}`);
  if (best && best.v > 0) lines.push(`🏆 الأحسن: ${best.title} (${best.v} مشاهدة)`);
  const hours = learnedShortHours(ctx);
  if (hours) lines.push(`🕒 مواعيد النشر الحالية: ${hours.map((h) => `${((h + 2 + 11) % 12) + 1} ${h + 2 < 12 ? 'ص' : 'م'}`).join(' و ')}`);
  const w = learnedFamilyWeights(ctx);
  if (w) { const name: Record<string, string> = { apps: 'التطبيقات', code: 'الأكواد', ios: 'الآيفون', android: 'الأندرويد' }; const top = Object.entries(w).sort((a, b) => b[1] - a[1])[0]!; if (top[1] > 1.05) lines.push(`📈 الأكتر نجاحاً: أسرار ${name[top[0]] ?? top[0]}`); }
  const lessons = ctx.repos.knowledge.byCategory('lesson').slice(0, 2);
  if (lessons.length) lines.push('', '📝 آخر دروس الفريق:', ...lessons.map((l) => `- ${l.insight.slice(0, 160)}`));
  lines.push('', '⏳ = لسه ما اتقاسش (بيتقاس بعد 24 ساعة من النشر)');
  return lines.join('\n');
}
