import { readFileSync, statSync } from 'node:fs';

/** TikTok Content Posting API client. Uses FILE_UPLOAD so no public media URL is needed. */
export class TikTokClient {
  private readonly token: string;
  private readonly privacy: string;
  private readonly f: typeof fetch;
  constructor(o: { accessToken: string; privacyLevel?: string; fetchImpl?: typeof fetch }) {
    this.token = o.accessToken;
    this.privacy = o.privacyLevel ?? 'SELF_ONLY';
    this.f = o.fetchImpl ?? fetch;
  }
  private async api(path: string, init: RequestInit = {}) {
    const res = await this.f(`https://open.tiktokapis.com/v2/${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json; charset=UTF-8', ...(init.headers ?? {}) },
    });
    const j = await res.json().catch(() => ({})) as any;
    if (!res.ok || j.error?.code && j.error.code !== 'ok') throw new Error(`TikTok ${path}: ${j.error?.message ?? res.status}`);
    return j;
  }
  async video(file: string, title: string): Promise<string> {
    const size = statSync(file).size;
    const info = await this.api('post/publish/creator_info/query/', { method: 'POST', body: '{}' });
    const allowed = info.data?.privacy_level_options ?? [];
    const privacy = allowed.includes(this.privacy) ? this.privacy : (allowed.includes('SELF_ONLY') ? 'SELF_ONLY' : allowed[0]);
    if (!privacy) throw new Error('TikTok returned no privacy level options');
    const init = await this.api('post/publish/video/init/', { method: 'POST', body: JSON.stringify({
      post_info: { title: title.slice(0, 2200), privacy_level: privacy, disable_comment: false, disable_duet: false, disable_stitch: false },
      source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: size, total_chunk_count: 1 },
    }) });
    const uploadUrl = init.data?.upload_url;
    const publishId = init.data?.publish_id;
    if (!uploadUrl || !publishId) throw new Error('TikTok did not return an upload URL');
    const data = readFileSync(file);
    const up = await this.f(uploadUrl, { method: 'PUT', headers: { 'content-type': 'video/mp4', 'content-length': String(data.length), 'content-range': `bytes 0-${data.length - 1}/${data.length}` }, body: new Uint8Array(data) });
    if (!up.ok) throw new Error(`TikTok upload: HTTP ${up.status}`);
    return String(publishId);
  }
}
