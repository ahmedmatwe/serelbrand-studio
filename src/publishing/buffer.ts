/**
 * TikTok through Buffer: Buffer's TikTok app is approved, so posts go out publicly (our own TikTok app would
 * stay private until TikTok audits it). Buffer fetches the video from a public link at posting time: the
 * Telegram bot's Worker serves it for 4 days from /media/<name>.
 * API: GraphQL at https://api.buffer.com, `Authorization: Bearer <key>` (Settings → API in Buffer).
 */
import { readFileSync } from 'node:fs';

export class BufferClient {
  private channel?: string;
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

  /** The connected TikTok channel (first one), found once. */
  async tiktokChannel(): Promise<string> {
    if (this.channel) return this.channel;
    const orgs = await this.gql<{ account: { organizations: { id: string }[] } }>('query { account { organizations { id name } } }');
    for (const org of orgs.account.organizations) {
      const c = await this.gql<{ channels: { id: string; service: string; name: string }[] }>('query($org: OrganizationId!) { channels(input: { organizationId: $org }) { id name service } }', { org: org.id });
      const tt = c.channels.find((x) => /tiktok/i.test(x.service));
      if (tt) return (this.channel = tt.id);
    }
    throw new Error('Buffer: no TikTok channel connected');
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
