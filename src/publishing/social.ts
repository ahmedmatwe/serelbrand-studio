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

export interface SocialTicket { title: string; caption: string; publishAt: string; platforms: ('facebook' | 'instagram')[]; done: string[]; tries: number; lastError?: string; video: string }

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
  const assets = await q.assets();
  for (const tAsset of assets.filter((a) => a.name.endsWith('.json'))) {
    const t = JSON.parse((await q.download(tAsset.id)).toString('utf8')) as SocialTicket;
    if (new Date(t.publishAt) > now) continue;
    const vAsset = assets.find((a) => a.name === t.video);
    if (!vAsset) { log.push(`missing video for ${t.title} — ticket dropped`); await q.remove(tAsset.id); continue; }
    const { writeFileSync, rmSync } = await import('node:fs');
    const file = `${tmpDir}/${t.video}`;
    writeFileSync(file, await q.download(vAsset.id));
    for (const p of t.platforms.filter((x) => !t.done.includes(x))) {
      try {
        const id = p === 'facebook' ? await meta.facebookReel(file, t.caption) : await meta.instagramReel(file, t.caption);
        t.done.push(p);
        log.push(`${p}: posted "${t.title}" (${id})`);
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
  return log;
}

export function socialFromEnv(env: { META_PAGE_ID?: string; META_PAGE_TOKEN?: string; META_IG_USER_ID?: string; META_GRAPH_VERSION: string }) {
  const repo = process.env.GITHUB_REPOSITORY, token = process.env.GITHUB_TOKEN;
  if (!env.META_PAGE_ID || !env.META_PAGE_TOKEN || !repo || !token) return undefined;
  return {
    queue: new SocialQueue({ repo, token }),
    meta: new MetaClient({ pageId: env.META_PAGE_ID, token: env.META_PAGE_TOKEN, igUserId: env.META_IG_USER_ID, version: env.META_GRAPH_VERSION }),
  };
}
