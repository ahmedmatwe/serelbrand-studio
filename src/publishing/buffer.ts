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
