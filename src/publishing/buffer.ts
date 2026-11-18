/**
 * TikTok through Buffer: Buffer's TikTok app is approved, so posts go out publicly (our own TikTok app would
 * stay private until TikTok audits it). Buffer fetches the video from a public link at posting time: the
 * Telegram bot's Worker serves it for 4 days from /media/<name>.
 * API: GraphQL at https://api.buffer.com, `Authorization: Bearer <key>` (Settings → API in Buffer).
 */
import { readFileSync } from 'node:fs';

export interface BufferPost { id: string; text: string; status: 'draft' | 'error' | 'needs_approval' | 'scheduled' | 'sending' | 'sent'; dueAt?: string | null; sentAt?: string | null; externalLink?: string | null; error?: { message: string } | null; assets?: { source: string; type?: string }[] }

export class BufferClient {
  private channel?: string;
  private org?: string;
  private readonly o: { apiKey: string; fetchImpl?: typeof fetch };
  constructor(o: BufferClient['o']) { this.o = o; }

  private async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await (this.o.fetchImpl ?? fetch)('https://api.buffer.com', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.o.apiKey}` },
      body: JSON.stringify({ query, variables }),
    });
    const j = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message: string }[] };
    if (!res.ok || j.errors?.length) throw new Error(`Buffer: ${j.errors?.[0]?.message ?? `HTTP ${res.status}`}`);
    return j.data as T;
  }

  /**
   * OUR TikTok channel, found by its NAME. The same Buffer account also holds other channels' TikToks
   * (kader_kora): taking "the first TikTok" sent every «سر الموبايل» TikTok to كادر كورة. Never guess:
   * no channel with our name → refuse to post.
   */
  async tiktokChannel(): Promise<string> {
    if (this.channel) return this.channel;
    const want = new RegExp(process.env.BUFFER_TIKTOK_CHANNEL || 'ser[._ ]?mobile|سر[ _]?الموبايل', 'i');
    const seen: string[] = [];
    const orgs = await this.gql<{ account: { organizations: { id: string }[] } }>('query { account { organizations { id name } } }');
    for (const org of orgs.account.organizations) {
      const c = await this.gql<{ channels: { id: string; service: string; name: string }[] }>('query($org: OrganizationId!) { channels(input: { organizationId: $org }) { id name service } }', { org: org.id });
      for (const x of c.channels.filter((y) => /tiktok/i.test(y.service))) seen.push(x.name);
      const tt = c.channels.find((x) => /tiktok/i.test(x.service) && want.test(x.name) && !/kader|كادر/i.test(x.name));
      if (tt) { this.org = org.id; return (this.channel = tt.id); }
    }
    throw new Error(`Buffer: no «سر الموبايل» TikTok channel (found: ${seen.join(', ') || 'none'}) — not posting to another channel`);
  }

  /** The TikTok channel's latest posts (scheduled, sending, sent, failed), newest due first. */
  async recentTikTokPosts(n = 40): Promise<BufferPost[]> {
    const channelId = await this.tiktokChannel();
    const r = await this.gql<{ posts: { edges: { node: BufferPost }[] } }>(
      `query($org: OrganizationId!, $ch: ChannelId!, $n: Int) { posts(first: $n, input: { organizationId: $org, filter: { channelIds: [$ch], status: [error, scheduled, sending, sent] }, sort: [{ field: dueAt, direction: desc }] }) { edges { node { id text status dueAt sentAt externalLink error { message } assets { source type } } } } }`,
      { org: this.org, ch: channelId, n },
    );
    return r.posts.edges.map((e) => e.node);
  }

  /** Removes a scheduled post from Buffer (before it goes out). */
  async deletePost(id: string): Promise<void> {
    const r = await this.gql<{ deletePost: { id?: string; message?: string } }>('mutation($id: PostId!) { deletePost(input: { id: $id }) { ... on DeletePostSuccess { id } ... on MutationError { message } } }', { id });
    if (!r.deletePost.id) throw new Error(`Buffer: ${r.deletePost.message ?? 'not deleted'}`);
  }

  /** Schedules a TikTok video post at `dueAt` (UTC ISO). Returns Buffer's post id. */
  async scheduleTikTok(videoUrl: string, text: string, dueAt: string): Promise<string> {
    const channelId = await this.tiktokChannel();
    const r = await this.gql<{ createPost: { post?: { id: string }; message?: string } }>(
      `mutation($input: CreatePostInput!) { createPost(input: $input) { ... on PostActionSuccess { post { id dueAt } } ... on MutationError { message } } }`,
      { input: { channelId, text, schedulingType: 'automatic', mode: 'customScheduled', dueAt, assets: [{ video: { url: videoUrl, metadata: { thumbnailOffset: 1500 } } }], metadata: { tiktok: { isAiGenerated: true } } } },
    );
    if (!r.createPost.post) throw new Error(`Buffer: ${r.createPost.message ?? 'post not created'}`);
    return r.createPost.post.id;
  }
}

/** Puts a video on the bot's public /media link (kept 4 days) and returns the URL. */
export async function hostVideo(file: string, name: string, env: { BOT_URL?: string; BOT_INGEST_SECRET?: string }, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (!env.BOT_URL || !env.BOT_INGEST_SECRET) throw new Error('bot not connected (BOT_URL)');
  const safe = name.replace(/[^\w.-]+/g, '_').slice(-110).replace(/^[._]+/, '') || 'short.mp4';
  const res = await fetchImpl(`${env.BOT_URL.replace(/\/$/, '')}/media/${safe.endsWith('.mp4') ? safe : `${safe}.mp4`}`, { method: 'PUT', headers: { authorization: `Bearer ${env.BOT_INGEST_SECRET}`, 'content-type': 'video/mp4' }, body: new Uint8Array(readFileSync(file)) });
  const j = (await res.json().catch(() => ({}))) as { url?: string };
  if (!res.ok || !j.url) throw new Error(`video hosting failed: HTTP ${res.status}`);
  return j.url;
}

export const bufferFromEnv = (env: { BUFFER_API_KEY?: string }) => (env.BUFFER_API_KEY ? new BufferClient({ apiKey: env.BUFFER_API_KEY }) : undefined);

/**
 * Sends Shorts already waiting in the Facebook/Instagram queue to TikTok too (e.g. produced before Buffer was
 * connected). Each ticket is marked with its Buffer post id, so it is never sent twice.
 */
export async function backfillTikTok(
  queue: { assets(): Promise<{ id: number; name: string }[]>; download(id: number): Promise<Buffer>; upload(name: string, data: Buffer, type: string): Promise<unknown>; remove(id: number): Promise<unknown> },
  buffer: BufferClient, hours: number[], env: { BOT_URL?: string; BOT_INGEST_SECRET?: string }, tmpDir: string, now = new Date(),
): Promise<string[]> {
  const { writeFileSync, rmSync } = await import('node:fs');
  const { platformTime } = await import('../analytics/learner.ts');
  const log: string[] = [];
  const assets = await queue.assets();
  const tickets = assets.filter((a) => a.name.endsWith('.mp4.json')).sort((a, b) => a.name.localeCompare(b.name));
  const byDay = new Map<string, number>();
  for (const a of tickets) {
    const t = JSON.parse((await queue.download(a.id)).toString('utf8')) as { title: string; caption: string; captions?: Record<string, string>; publishAt: string; video: string; bufferId?: string; tiktokAt?: string; at?: Record<string, string>; platforms?: string[] };
    const day = t.publishAt.slice(0, 10);
    const i = byDay.get(day) ?? 0; byDay.set(day, i + 1);
    if (t.bufferId || new Date(t.publishAt).getFullYear() > 2090) continue; // already sent / held back
    // A ticket may carry its own TikTok time (catching up the back catalogue); else TikTok's i-th best hour.
    const at = t.at?.tiktok ?? platformTime(hours, t.publishAt, i, now);
    if (new Date(at).getTime() < now.getTime() + 10 * 60_000) { log.push(`skip (time passed): ${t.title}`); continue; }
    const v = assets.find((x) => x.name === t.video);
    if (!v) continue;
    const file = `${tmpDir}/${t.video}`;
    writeFileSync(file, await queue.download(v.id));
    try {
      const url = await hostVideo(file, t.video, env);
      t.bufferId = await buffer.scheduleTikTok(url, t.captions?.tiktok || t.caption, at);
      t.tiktokAt = at;
      await queue.remove(a.id);
      // TikTok-only tickets are done once Buffer has them (the video is served from the bot's link).
      if (t.platforms && !t.platforms.length) await queue.remove(v.id);
      else await queue.upload(a.name, Buffer.from(JSON.stringify(t)), 'application/json');
      log.push(`tiktok: scheduled "${t.title}" at ${at} (buffer ${t.bufferId})`);
    } catch (e) {
      log.push(`tiktok: FAILED "${t.title}" — ${(e as Error).message.slice(0, 200)}`);
    } finally { rmSync(file, { force: true }); }
  }
  return log;
}

/**
 * What the owner must hear about TikTok: a failed post (with Buffer's reason) or one still not out 45 min after
 * its time. Each alert has a stable id, so the bot sends it once only.
 */
export function tiktokAlerts(posts: BufferPost[], now = new Date(), retried: Set<string> = new Set()): { id: string; text: string }[] {
  const title = (t: string) => t.split('\n')[0]!.slice(0, 70);
  const out: { id: string; text: string }[] = [];
  for (const p of posts) {
    const due = p.dueAt ? Date.parse(p.dueAt) : NaN;
    if (p.status === 'sent' && p.sentAt && now.getTime() - Date.parse(p.sentAt) < 6 * 3_600_000) out.push({ id: `tt-sent-${p.id}`, text: `🎵 تيك توك: اتنشر «${title(p.text)}»${p.externalLink ? `\n${p.externalLink}` : ''}` });
    else if (p.status === 'error' && !retried.has(p.id)) out.push({ id: `tt-error-${p.id}`, text: `❌ تيك توك: الفيديو «${title(p.text)}» فشل نشره.\nالسبب من Buffer: ${p.error?.message ?? 'غير معروف'}\nافتح Buffer ← تيك توك وجرّب «Retry»، أو قولّي وأنا أعيد جدولته.` });
    else if ((p.status === 'scheduled' || p.status === 'sending') && Number.isFinite(due) && now.getTime() - due > 45 * 60_000 && now.getTime() - due < 2 * 86_400_000)
      out.push({ id: `tt-late-${p.id}`, text: `⏰ تيك توك: الفيديو «${title(p.text)}» كان المفروض ينزل الساعة ${new Date(due + 2 * 3_600_000).toISOString().slice(11, 16)} بتوقيت القاهرة ولسه منزلش (الحالة: ${p.status}). ممكن قناة تيك توك تكون محتاجة تتربط تاني في Buffer.` });
  }
  return out;
}

/** Invisible marker appended to a re-sent caption: counts automatic retries without any stored state. */
const RETRY_MARK = '\u200b';
const retries = (t: string) => (t.match(new RegExp(RETRY_MARK, 'g')) ?? []).length;
/** Buffer errors worth simply trying again (its own processing hiccups), vs ones that need the owner. */
export const retryableError = (m = '') => /delay|processing|timed? ?out|temporar|try again|retry|unexpected|internal/i.test(m) && !/disconnect|reconnect|permission|token|auth|banned|violat|guideline/i.test(m);

/**
 * Self-healing: a TikTok post that failed for a passing reason (e.g. "media hit some delays while processing —
 * please retry") is re-created with the same video and caption 20 minutes later and the failed one removed;
 * at most 2 retries per video, only within a day of its time. Returns the handled post ids + Telegram alerts.
 */
export async function retryFailedTikToks(buffer: BufferClient, posts: BufferPost[], now = new Date()): Promise<{ retried: Set<string>; alerts: { id: string; text: string }[]; log: string[] }> {
  const retried = new Set<string>();
  const alerts: { id: string; text: string }[] = [];
  const log: string[] = [];
  for (const p of posts) {
    const due = p.dueAt ? Date.parse(p.dueAt) : now.getTime();
    const src = p.assets?.find((a) => a.source)?.source;
    if (p.status !== 'error' || !retryableError(p.error?.message) || retries(p.text) >= 2 || now.getTime() - due > 86_400_000 || !src) continue;
    const at = new Date(now.getTime() + 20 * 60_000).toISOString();
    try {
      const id = await buffer.scheduleTikTok(src, `${p.text}${RETRY_MARK}`, at);
      await buffer.deletePost(p.id).catch(() => undefined);
      retried.add(p.id);
      log.push(`tiktok retry: ${p.id} → ${id} at ${at}`);
      alerts.push({ id: `tt-retry-${p.id}`, text: `🔁 تيك توك: «${p.text.split('\n')[0]!.slice(0, 70)}» فشل لسبب مؤقت عند Buffer (${(p.error?.message ?? '').slice(0, 80)}) — أعدت جدولته لوحدي، هينزل خلال 20 دقيقة.` });
    } catch (e) { log.push(`tiktok retry FAILED ${p.id}: ${(e as Error).message.slice(0, 160)}`); }
  }
  return { retried, alerts, log };
}
