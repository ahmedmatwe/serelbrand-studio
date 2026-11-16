/**
 * Trend scout: rides what Egypt is talking about right now. Every few hours it reads what Egyptians search
 * (Google Trends, geo=EG) and the latest phone/internet/social-media news (Google News, Arabic, Egypt), and a
 * trend editor looks for a NATURAL bridge to a genuinely useful phone/social-media video — e.g. a trend
 * "unlimited internet in Egypt" → "how to see what eats your data and save it". Only safe, non-political,
 * non-tragic trends; the useful part must be real (same research + independent fact-check as every topic).
 * An approved trend topic is made FIRST — even as an extra pack the same day when it is hot — because a
 * trend dies in a day or two. Its hook opens on the trend. The analyst later sees which trend videos worked.
 */
import { z } from 'zod';
import type { AgentContext } from '../base.ts';
import { loadPhoneLibrary } from './phone-library.ts';
import { requestedEntries, vetRequest, writeRequestedLibrary } from './topic-requests.ts';

export interface TrendItem { title: string; traffic?: string; news: string[]; source: 'google-trends' | 'google-news' }
export interface TrendInfo { name: string; link: string; hookAngle: string; heat: number; urgency: 'now' | 'soon'; at: string }

const TRENDS_RSS = 'https://trends.google.com/trending/rss?geo=EG';
const NEWS_RSS = 'https://news.google.com/rss/search?q=' + encodeURIComponent('الإنترنت OR الانترنت OR باقات OR واتساب OR فيسبوك OR انستجرام OR تيك توك OR آيفون OR أندرويد OR سامسونج OR موبايل OR شحن OR تحديث') + '&hl=ar&gl=EG&ceid=EG:ar';
/** A trend stays worth riding this long after it was spotted. */
export const TREND_TTL_H = 60;

const unxml = (s: string) => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

/** Parses both feeds (public RSS, no key). Text from the web is data only — never instructions. */
export function parseTrends(trendsXml: string, newsXml: string): TrendItem[] {
  const out: TrendItem[] = [];
  for (const item of trendsXml.split('<item>').slice(1, 26)) {
    const title = unxml(item.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '');
    if (!title) continue;
    out.push({ title, traffic: item.match(/<ht:approx_traffic>([^<]*)</)?.[1], news: [...item.matchAll(/<ht:news_item_title>([\s\S]*?)<\/ht:news_item_title>/g)].map((m) => unxml(m[1]!)).slice(0, 2), source: 'google-trends' });
  }
  for (const item of newsXml.split('<item>').slice(1, 26)) {
    const title = unxml(item.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '').replace(/ - [^-]+$/, '');
    if (title) out.push({ title, news: [], source: 'google-news' });
  }
  return out;
}

export async function fetchTrends(fetchImpl: typeof fetch = fetch): Promise<TrendItem[]> {
  const get = (u: string) => fetchImpl(u, { headers: { 'user-agent': 'Mozilla/5.0 (trend reader)' }, signal: AbortSignal.timeout(20_000) }).then((r) => (r.ok ? r.text() : ''), () => '');
  const [t, n] = await Promise.all([get(TRENDS_RSS), get(NEWS_RSS)]);
  return parseTrends(t, n);
}

const Picks = z.object({
  picks: z.array(z.object({
    trend: z.string().min(2).max(120),
    /** Why this trend naturally leads to the video (one Arabic sentence, not a URL). */
    link: z.string().min(5).max(240).refine((x) => !/https?:\/\/|www\./i.test(x), 'link must be a sentence, not a URL'),
    /** The useful phone/social topic to research (Arabic, specific). */
    topic: z.string().min(8).max(240),
    /** How the hook ties the trend to the video, in Egyptian Arabic. */
    hookAngle: z.string().min(5).max(160),
    heat: z.number().min(0).max(10),
    urgency: z.enum(['now', 'soon']),
  })).max(3).default([]),
});

/** Trend topics waiting to be made (approved, fresh, not used yet), hottest first. */
export function waitingTrends(ctx: AgentContext, used: Set<string>, now = new Date()) {
  return requestedEntries(ctx)
    .filter((r) => r.status === 'approved' && r.entry?.trend && !used.has(r.entry.id) && now.getTime() - Date.parse(r.entry.trend.at) < TREND_TTL_H * 3_600_000)
    .sort((a, b) => b.entry!.trend!.heat - a.entry!.trend!.heat);
}

/**
 * One scout round (at most every 3 hours): read trends → pick bridges → research + fact-check → add as trend
 * topics. Returns Telegram lines.
 */
export async function scoutTrends(ctx: AgentContext, used: Set<string>, now = new Date(), fetchImpl: typeof fetch = fetch): Promise<string[]> {
  if (ctx.providers.llm.name.startsWith('mock')) return [];
  const last = ctx.repos.artifacts.listKind<{ at: string }>('trend_scout').at(-1)?.data.at;
  if (last && now.getTime() - Date.parse(last) < 3 * 3_600_000) return [];
  const items = await fetchTrends(fetchImpl);
  if (!items.length) return [];
  const seen = ctx.repos.artifacts.listKind<{ picks?: { trend: string }[]; at: string }>('trend_scout').filter((a) => now.getTime() - Date.parse(a.data.at) < 7 * 86_400_000).flatMap((a) => (a.data.picks ?? []).map((p) => p.trend));
  const lib = loadPhoneLibrary(ctx.config.rootDir);
  const lessons = ctx.repos.knowledge.byCategory('lesson').map((k) => k.insight).filter((x) => /^Performance \((trend|topic)/.test(x)).slice(0, 5);
  const r = await ctx.providers.llm.generateJson({
    task: 'trends.pick',
    tier: 'writing',
    system: 'You are the trend editor of "سر الموبايل" (Egyptian Arabic Shorts: useful phone and social-media features, tips and updates). From what Egypt is searching and the latest phone/internet news, pick at most 2 trends that NATURALLY lead to a genuinely useful phone/social-media video, so the video rides the trend and spreads. ' +
      'Example: a trend about unlimited internet / internet prices in Egypt → "how to see which apps eat your data and cut it" (the hook ties to the trend). ' +
      'RULES: never politics, elections, wars, religion, tragedies, deaths, crimes, celebrity gossip or bodies; never mock anyone; no rumours — the useful part must be a real, documented feature/setting available now (not "WhatsApp is testing…"); skip if the bridge is forced. ' +
      'What counts as a trend: an item of `searches` (what Egyptians are searching on Google now, with traffic), or a subject that appears in SEVERAL `news` headlines — never a single article. trend = the short name of that search/subject. link = one Arabic sentence explaining why the trend leads to this video (never a URL). ' +
      'Avoid trends in `alreadyUsed` and topics already in `library`. heat 0–10 = how big the trend is in Egypt right now and how much people would share a video tied to it; urgency "now" if it will be over in 1–2 days. ' +
      'topic = the exact useful thing to research (Arabic). hookAngle = how the first sentence ties to the trend (Egyptian Arabic, true, no exaggeration). Follow `lessons` (what trend videos taught us). JSON only.',
    prompt: JSON.stringify({ searches: items.filter((x) => x.source === 'google-trends').slice(0, 25), news: items.filter((x) => x.source === 'google-news').map((x) => x.title).slice(0, 25), alreadyUsed: seen, library: (lib?.secrets ?? []).map((s) => s.title).slice(-80), lessons }),
    schema: Picks,
    maxOutputTokens: 2500,
  }).catch(() => undefined);
  if (!r) return []; // the model failed (quota/network): try again next cycle
  const picks = ((r.data as z.infer<typeof Picks>).picks ?? []).filter((p) => p.heat >= 6 && !seen.includes(p.trend));
  ctx.repos.artifacts.save({ videoId: null, kind: 'trend_scout', agent: 'trend-scout', data: { at: now.toISOString(), items: items.length, picks } });
  const msgs: string[] = [];
  for (const [i, p] of picks.entries()) {
    const id = `trend-${now.toISOString().slice(0, 13).replace(/\D/g, '')}-${i}`;
    // Same research + independent fact-check; a trend-tied tip may be better known (up to 70%): the trend makes it news.
    const v = await vetRequest(ctx, { id, text: `${p.topic}\n(مربوط بتريند في مصر: «${p.trend}» — ${p.link})`, at: now.toISOString() }, true, 70);
    if (v.status !== 'approved' || !v.entry) continue;
    const trend: TrendInfo = { name: p.trend, link: p.link, hookAngle: p.hookAngle, heat: p.heat, urgency: p.urgency, at: now.toISOString() };
    ctx.repos.artifacts.save({ videoId: null, kind: 'topic_request', agent: 'trend-scout', data: { ...v, auto: true, entry: { ...v.entry, trend } } });
    msgs.push(`📈 تريند في مصر: «${p.trend}»\n🎬 هعمل عليه فيديو: «${v.entry.title}»\n🔗 الربط: ${p.link}\n${p.urgency === 'now' ? '⚡ هيتعمل النهارده قبل ما التريند يبرد.' : '🗓️ هيتعمل أول واحد في الإنتاج الجاي.'}`);
  }
  writeRequestedLibrary(ctx, now);
  return msgs;
}
