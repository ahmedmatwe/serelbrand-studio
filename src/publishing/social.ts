/**
 * Cross-posting every published Short as a Reel on the Facebook Page and the linked Instagram account
 * (Meta Graph API, free), at the same time it goes public on YouTube.
 *
 * Instagram's API cannot schedule, and the GitHub runner that rendered a Short is gone by its publish time,
 * so each Short waits in a "social queue": a GitHub release whose assets are the video + a small JSON ticket
 * (time, caption, which platforms are done). A light workflow (social.yml) runs every 15 minutes, posts what
 * is due and deletes the files once every platform has it. Nothing is ever posted twice: a platform is marked
 * done the moment it succeeds, and a failed platform is retried on the next run (max 5 tries).
 */
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

export interface SocialTicket { title: string; caption: string; /** Platform-specific caption (written by each platform's specialist). */ captions?: Partial<Record<'facebook' | 'instagram', string>>; publishAt: string; videoId?: string; secretId?: string; family?: string; platforms: ('facebook' | 'instagram')[]; done: string[]; tries: number; lastError?: string; video: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- Meta
export class MetaClient {
  private igUser?: string;
  private readonly o: { pageId: string; token: string; igUserId?: string; version: string; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> };
  constructor(o: MetaClient['o']) { this.o = o; this.igUser = o.igUserId; }
  private get f() { return this.o.fetchImpl ?? fetch; }
  private async graph(path: string, params: Record<string, string>, method = 'POST') {
    const url = `https://graph.facebook.com/${this.o.version}/${path}`;
    const body = new URLSearchParams({ ...params, access_token: this.o.token });
    const res = method === 'GET' ? await this.f(`${url}?${body}`) : await this.f(url, { method, body });
    const j = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok || j.error) throw new Error(`Meta ${path}: ${j.error?.message ?? res.status}`);
    return j;
  }
  private async rupload(uri: string, file: string) {
    const data = readFileSync(file);
    const res = await this.f(uri, { method: 'POST', headers: { authorization: `OAuth ${this.o.token}`, offset: '0', file_size: String(data.length), 'content-type': 'application/octet-stream' }, body: new Uint8Array(data) });
    const j = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok || j.success === false || j.error) throw new Error(`Meta upload: ${j.error?.message ?? j.debug_info?.message ?? res.status}`);
  }

  /** Read-only connection check: page name, token validity, linked Instagram account. Posts nothing. */
  async check(): Promise<{ page: string; instagram?: string }> {
    const p = await this.graph(this.o.pageId, { fields: 'name,instagram_business_account{username}' }, 'GET');
    if (p.instagram_business_account?.id) this.igUser ??= p.instagram_business_account.id;
    return { page: p.name, instagram: p.instagram_business_account?.username };
  }

  /** Facebook Reel counters (plays from insights when allowed, else likes/comments only). */
  async facebookStats(id: string): Promise<{ views: number; likes?: number; comments?: number; insightsError?: string }> {
    const base = await this.graph(id, { fields: 'likes.summary(true).limit(0),comments.summary(true).limit(0)' }, 'GET').catch(() => ({} as Record<string, any>));
    let err = '';
    const ins = await this.graph(`${id}/video_insights`, { metric: 'blue_reels_play_count' }, 'GET').catch((e: Error) => { err = e.message; return undefined; });
    const plays = Number(ins?.data?.[0]?.values?.[0]?.value ?? NaN);
    return { views: Number.isFinite(plays) ? plays : 0, likes: base.likes?.summary?.total_count, comments: base.comments?.summary?.total_count, ...(err ? { insightsError: err.slice(0, 200) } : {}) };
  }

  /** Instagram Reel counters (views/shares/saves from insights when allowed, else likes/comments). */
  async instagramStats(id: string): Promise<{ views: number; likes?: number; comments?: number; shares?: number; saves?: number; reach?: number; insightsError?: string }> {
    const base = await this.graph(id, { fields: 'like_count,comments_count' }, 'GET');
    let err = '';
    const ins = await this.graph(`${id}/insights`, { metric: 'views,shares,saved,reach' }, 'GET').catch((e: Error) => { err = e.message; return undefined; });
    const get = (n: string) => Number((ins?.data as { name: string; values: { value: number }[] }[] | undefined)?.find((d) => d.name === n)?.values?.[0]?.value ?? NaN);
    const opt = (n: string) => (Number.isFinite(get(n)) ? get(n) : undefined);
    return { views: opt('views') ?? 0, likes: base.like_count, comments: base.comments_count, shares: opt('shares'), saves: opt('saved'), reach: opt('reach'), ...(err ? { insightsError: err.slice(0, 200) } : {}) };
  }

  /** Followers of the Facebook Page and the Instagram account. */
  async followers(): Promise<{ facebook?: number; instagram?: number }> {
    const p = await this.graph(this.o.pageId, { fields: 'followers_count,fan_count,instagram_business_account{followers_count}' }, 'GET');
    return { facebook: p.followers_count ?? p.fan_count, instagram: p.instagram_business_account?.followers_count };
  }

  /** Instagram professional account linked to the Page. */
  async instagramUser(): Promise<string | undefined> {
    if (this.igUser) return this.igUser;
    const j = await this.graph(this.o.pageId, { fields: 'instagram_business_account' }, 'GET');
    return (this.igUser = j.instagram_business_account?.id);
  }

  /** Facebook Reel on the Page (resumable upload, published now). */
  async facebookReel(file: string, description: string): Promise<string> {
    const start = await this.graph(`${this.o.pageId}/video_reels`, { upload_phase: 'start' });
    await this.rupload(start.upload_url ?? `https://rupload.facebook.com/video-upload/${this.o.version}/${start.video_id}`, file);
    await this.graph(`${this.o.pageId}/video_reels`, { upload_phase: 'finish', video_id: start.video_id, video_state: 'PUBLISHED', description });
    return String(start.video_id);
  }

  /** Instagram Reel (resumable upload → wait until processed → publish). */
  async instagramReel(file: string, caption: string): Promise<string> {
    const ig = await this.instagramUser();
    if (!ig) throw new Error('No Instagram professional account is linked to the Facebook Page');
    const c = await this.graph(`${ig}/media`, { media_type: 'REELS', upload_type: 'resumable', caption, share_to_feed: 'true' });
    await this.rupload(c.uri, file);
    for (let i = 0; i < 60; i++) {
      const st = await this.graph(String(c.id), { fields: 'status_code,status' }, 'GET');
      if (st.status_code === 'FINISHED') break;
      if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') throw new Error(`Instagram processing failed: ${st.status ?? st.status_code}`);
      await (this.o.sleep ?? sleep)(10_000);
    }
    const p = await this.graph(`${ig}/media_publish`, { creation_id: String(c.id) });
    return String(p.id);
  }
}

// ---------------------------------------------------------------- queue (GitHub release assets)
export class SocialQueue {
  private releaseId?: number;
  private readonly o: { repo: string; token: string; tag?: string; fetchImpl?: typeof fetch };
  constructor(o: SocialQueue['o']) { this.o = o; }
  private get f() { return this.o.fetchImpl ?? fetch; }
  private h(extra: Record<string, string> = {}) { return { authorization: `Bearer ${this.o.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...extra }; }
  private get tag() { return this.o.tag ?? 'social-queue'; }

  private async release(): Promise<number> {
    if (this.releaseId) return this.releaseId;
    const api = `https://api.github.com/repos/${this.o.repo}/releases`;
    let r = await this.f(`${api}/tags/${this.tag}`, { headers: this.h() });
    if (r.status === 404) {
      r = await this.f(api, { method: 'POST', headers: this.h({ 'content-type': 'application/json' }), body: JSON.stringify({ tag_name: this.tag, name: 'Social queue (automatic)', body: 'Shorts waiting to be posted on Facebook/Instagram. Managed by the autopilot — files are deleted once posted.', prerelease: true }) });
    }
    if (!r.ok) throw new Error(`GitHub release: HTTP ${r.status}`);
    return (this.releaseId = ((await r.json()) as { id: number }).id);
  }
  async assets(): Promise<{ id: number; name: string }[]> {
    const id = await this.release();
    const r = await this.f(`https://api.github.com/repos/${this.o.repo}/releases/${id}/assets?per_page=100`, { headers: this.h() });
    if (!r.ok) throw new Error(`GitHub assets: HTTP ${r.status}`);
    return (await r.json()) as { id: number; name: string }[];
  }
  async upload(name: string, data: Buffer, type: string) {
    const id = await this.release();
    const r = await this.f(`https://uploads.github.com/repos/${this.o.repo}/releases/${id}/assets?name=${encodeURIComponent(name)}`, { method: 'POST', headers: this.h({ 'content-type': type }), body: new Uint8Array(data) });
    if (!r.ok) throw new Error(`GitHub upload ${name}: HTTP ${r.status}`);
  }
  async download(assetId: number): Promise<Buffer> {
    const r = await this.f(`https://api.github.com/repos/${this.o.repo}/releases/assets/${assetId}`, { headers: this.h({ accept: 'application/octet-stream' }) });
    if (!r.ok) throw new Error(`GitHub download: HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
  async remove(assetId: number) {
    await this.f(`https://api.github.com/repos/${this.o.repo}/releases/assets/${assetId}`, { method: 'DELETE', headers: this.h() });
  }
}

/** Caption for Facebook/Instagram: title, the Short's own opening lines, hashtags. */
export function socialCaption(title: string, lead: string, hashtags: string[]): string {
  const tags = [...new Set(['#سر_الموبايل', ...hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`).replace(/\s+/g, '_'))])].slice(0, 12);
  return `${title.replace(/#\S+/g, '').trim()}\n\n${lead.trim()}\n\n${tags.join(' ')}`.slice(0, 2100);
}

/** Puts a rendered Short in the queue (video + ticket). Safe name = publish time + slug, so they sort by time. */
export async function enqueue(q: SocialQueue, file: string, t: Omit<SocialTicket, 'done' | 'tries' | 'video'>) {
  const stamp = t.publishAt.replace(/[:.]/g, '-');
  const slug = basename(file).replace(/[^\w.-]+/g, '_');
  const video = `${stamp}__${Date.now().toString(36)}__${slug}`;
  statSync(file);
  await q.upload(video, readFileSync(file), 'video/mp4');
  await q.upload(`${video}.json`, Buffer.from(JSON.stringify({ ...t, done: [], tries: 0, video } satisfies SocialTicket)), 'application/json');
}

/** Posts every due ticket on the platforms it still lacks. Returns a log line per action. */
export async function processQueue(q: SocialQueue, meta: MetaClient, now = new Date(), tmpDir = '/tmp'): Promise<string[]> {
  const log: string[] = [];
  const posted: PostedEntry[] = [];
  const assets = await q.assets();
  for (const tAsset of assets.filter((a) => a.name.endsWith('.json') && a.name !== POSTED)) {
    const t = JSON.parse((await q.download(tAsset.id)).toString('utf8')) as SocialTicket;
    if (new Date(t.publishAt) > now) continue;
    const vAsset = assets.find((a) => a.name === t.video);
    if (!vAsset) { log.push(`missing video for ${t.title} — ticket dropped`); await q.remove(tAsset.id); continue; }
    const { writeFileSync, rmSync } = await import('node:fs');
    const file = `${tmpDir}/${t.video}`;
    writeFileSync(file, await q.download(vAsset.id));
    for (const p of t.platforms.filter((x) => !t.done.includes(x))) {
      try {
        const cap = t.captions?.[p] || t.caption;
        const id = p === 'facebook' ? await meta.facebookReel(file, cap) : await meta.instagramReel(file, cap);
        t.done.push(p);
        log.push(`${p}: posted "${t.title}" (${id})`);
        posted.push({ platform: p, id, at: new Date().toISOString(), title: t.title, videoId: t.videoId, secretId: t.secretId, family: t.family });
      } catch (err) {
        t.lastError = `${p}: ${(err as Error).message.slice(0, 200)}`;
        log.push(`${p}: FAILED "${t.title}" — ${t.lastError}`);
      }
    }
    rmSync(file, { force: true });
    const finished = t.platforms.every((x) => t.done.includes(x));
    t.tries++;
    await q.remove(tAsset.id);
    if (finished || t.tries >= 5) {
      await q.remove(vAsset.id);
      if (!finished) log.push(`giving up on "${t.title}" after ${t.tries} tries: ${t.lastError}`);
    } else {
      await q.upload(tAsset.name, Buffer.from(JSON.stringify(t)), 'application/json');
    }
  }
  if (posted.length) await appendPosted(q, posted);
  return log;
}

/** What was posted where (read by the autopilot's learner to measure each Reel). */
export interface PostedEntry { platform: 'facebook' | 'instagram'; id: string; at: string; title: string; videoId?: string; secretId?: string; family?: string }
const POSTED = 'posted-log.json';
export async function readPosted(q: SocialQueue): Promise<PostedEntry[]> {
  const a = (await q.assets()).find((x) => x.name === POSTED);
  return a ? (JSON.parse((await q.download(a.id)).toString('utf8')) as PostedEntry[]) : [];
}
async function appendPosted(q: SocialQueue, entries: PostedEntry[]) {
  const a = (await q.assets()).find((x) => x.name === POSTED);
  const all = [...(a ? (JSON.parse((await q.download(a.id)).toString('utf8')) as PostedEntry[]) : []), ...entries].slice(-2000);
  if (a) await q.remove(a.id);
  await q.upload(POSTED, Buffer.from(JSON.stringify(all)), 'application/json');
}

export function socialFromEnv(env: { META_PAGE_ID?: string; META_PAGE_TOKEN?: string; META_IG_USER_ID?: string; META_GRAPH_VERSION: string }) {
  const repo = process.env.GITHUB_REPOSITORY, token = process.env.GITHUB_TOKEN;
  if (!env.META_PAGE_ID || !env.META_PAGE_TOKEN || !repo || !token) return undefined;
  return {
    queue: new SocialQueue({ repo, token }),
    meta: new MetaClient({ pageId: env.META_PAGE_ID, token: env.META_PAGE_TOKEN, igUserId: env.META_IG_USER_ID, version: env.META_GRAPH_VERSION }),
  };
}

/**
 * Platform specialists: the same Short gets a caption written the way each platform works —
 * Instagram: strong first line (shown before "more"), save/share call, 8–12 niche hashtags;
 * Facebook: conversational question that invites comments, 2–3 hashtags.
 * Facts only from the Short's own narration. Falls back to the plain caption if the model is unavailable.
 */
export async function platformCaptions(ctx: { providers: { llm: { generateJson: (r: any) => Promise<{ data: any }> } } }, title: string, narration: string, hashtags: string[], videoId?: string): Promise<Partial<Record<'facebook' | 'instagram', string>>> {
  const { z } = await import('zod');
  const r = await ctx.providers.llm.generateJson({
    task: 'social.captions',
    tier: 'light',
    system: 'You are the social media manager of an Egyptian Arabic channel about phone secrets ("سر الموبايل"). Write captions in natural Egyptian Arabic for the SAME Reel on two platforms, each in its native style. ' +
      'instagram: first line = a hook that makes people tap "more" (≤ 10 words, emoji ok); 2–3 short lines with the exact code/steps from the narration; a call to SAVE and SEND to a friend; then 8–12 relevant Arabic+English hashtags (#سر_الموبايل first). ' +
      'facebook: 2–4 conversational lines, end with a question that invites comments (e.g. "جربتها؟ قولنا في الكومنتات"), 2–3 hashtags. ' +
      'Never add facts, codes or steps that are not in the narration. JSON only: {"instagram":"…","facebook":"…"}.',
    prompt: JSON.stringify({ title, narration, hashtags }),
    schema: z.object({ instagram: z.string().min(20), facebook: z.string().min(20) }),
    videoId,
    maxOutputTokens: 1500,
  }).catch(() => undefined);
  return r ? { instagram: String(r.data.instagram).slice(0, 2100), facebook: String(r.data.facebook).slice(0, 2100) } : {};
}
