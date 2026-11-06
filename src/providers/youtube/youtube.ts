import { createReadStream, readFileSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { ProviderError } from '../../core/errors.ts';
import { sleep as realSleep } from '../../core/retry.ts';
import type { UploadRequest, UploadResult, YouTubeProvider } from '../media.ts';
import type { TokenSource } from './oauth.ts';

const API = 'https://www.googleapis.com';
type UploadedStatus = { privacyStatus?: string; publishAt?: string; uploadStatus?: string };

export interface RealYouTubeOptions {
  tokens: TokenSource;
  categoryId: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxResumes?: number;
}

/**
 * YouTube Data API v3 (resumable upload, thumbnail, captions) + YouTube Analytics API v2.
 * Quota (default 10,000 units/day): videos.insert ≈ 1,600, captions.insert 400, thumbnails.set 50.
 */
export class RealYouTube implements YouTubeProvider {
  readonly name = 'youtube';
  private readonly o: Required<Omit<RealYouTubeOptions, 'tokens'>> & { tokens: TokenSource };
  constructor(o: RealYouTubeOptions) {
    this.o = { fetchImpl: fetch, sleep: realSleep, maxResumes: 5, ...o };
  }

  private async auth(extra: Record<string, string> = {}) {
    return { authorization: `Bearer ${await this.o.tokens.token()}`, ...extra };
  }

  private async fail(res: Response, what: string): Promise<never> {
    const j = (await res.json().catch(() => ({}))) as { error?: { message?: string; errors?: { reason?: string }[] } };
    const reason = j.error?.errors?.[0]?.reason ?? '';
    const quota = reason === 'quotaExceeded' || reason === 'uploadLimitExceeded';
    throw new ProviderError('youtube', `${what}: HTTP ${res.status} ${reason} ${j.error?.message ?? ''}`.trim() + (quota ? ' (daily quota reached — try tomorrow)' : ''), !quota && (res.status >= 500 || res.status === 429));
  }

  async channel(): Promise<{ id: string; title: string; subscribers?: number; videos?: number }> {
    const res = await this.o.fetchImpl(`${API}/youtube/v3/channels?part=snippet,statistics&mine=true`, { headers: await this.auth() });
    if (!res.ok) await this.fail(res, 'channels.list');
    const j = (await res.json()) as { items?: { id: string; snippet: { title: string }; statistics?: { subscriberCount?: string; videoCount?: string } }[] };
    const c = j.items?.[0];
    if (!c) throw new ProviderError('youtube', 'This Google account has no YouTube channel yet — create one at youtube.com first', false);
    return { id: c.id, title: c.snippet.title, subscribers: Number(c.statistics?.subscriberCount ?? NaN), videos: Number(c.statistics?.videoCount ?? NaN) };
  }

  /** Resumable upload: create session → stream bytes → on interruption ask the server what it has and resume. */
  async upload(req: UploadRequest): Promise<UploadResult> {
    const size = statSync(req.videoPath).size;
    const meta = {
      snippet: {
        title: req.title.slice(0, 100),
        description: req.description.slice(0, 5000),
        tags: req.tags,
        categoryId: req.categoryId ?? this.o.categoryId,
        defaultLanguage: req.defaultLanguage,
        defaultAudioLanguage: req.defaultLanguage,
      },
      status: {
        privacyStatus: req.visibility,
        ...(req.publishAt ? { publishAt: req.publishAt } : {}),
        selfDeclaredMadeForKids: false,
        containsSyntheticMedia: req.containsSyntheticMedia,
        embeddable: true,
      },
    };
    const init = await this.o.fetchImpl(`${API}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`, {
      method: 'POST',
      headers: await this.auth({ 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': 'video/mp4', 'x-upload-content-length': String(size) }),
      body: JSON.stringify(meta),
    });
    if (!init.ok) await this.fail(init, 'videos.insert (start)');
    const session = init.headers.get('location');
    if (!session) throw new ProviderError('youtube', 'No resumable session URL', true);

    let offset = 0;
    let videoId: string | undefined;
    let finalStatus: UploadedStatus | undefined;
    for (let attempt = 0; attempt <= this.o.maxResumes && !videoId; attempt++) {
      try {
        const body = Readable.toWeb(createReadStream(req.videoPath, { start: offset })) as unknown as BodyInit;
        const res = await this.o.fetchImpl(session, {
          method: 'PUT',
          headers: await this.auth({ 'content-type': 'video/mp4', 'content-length': String(size - offset), ...(offset ? { 'content-range': `bytes ${offset}-${size - 1}/${size}` } : {}) }),
          body,
          duplex: 'half',
        } as RequestInit);
        if (res.ok) { const j = (await res.json()) as { id: string; status?: UploadedStatus }; videoId = j.id; finalStatus = j.status; break; }
        if (res.status < 500 && res.status !== 308) await this.fail(res, 'videos.insert (upload)');
      } catch (err) {
        if (err instanceof ProviderError && !err.retryable) throw err;
      }
      // Ask how much arrived, then resume from there.
      await this.o.sleep(Math.min(30_000, 1000 * 2 ** attempt));
      const st = await this.o.fetchImpl(session, { method: 'PUT', headers: await this.auth({ 'content-range': `bytes */${size}`, 'content-length': '0' }) });
      if (st.ok) { const j = (await st.json()) as { id: string; status?: UploadedStatus }; videoId = j.id; finalStatus = j.status; break; }
      if (st.status === 308) {
        const range = st.headers.get('range'); // "bytes=0-12345"
        offset = range ? Number(range.split('-')[1]) + 1 : 0;
      } else if (st.status === 404 || st.status === 410) {
        throw new ProviderError('youtube', 'Upload session expired — run publish again', true);
      }
    }
    if (!videoId) throw new ProviderError('youtube', 'Upload did not complete after retries', true);

    // Thumbnail + captions are best-effort: the video is already up (private), so failures become warnings.
    const warnings: string[] = [];
    // Unverified API projects get uploads locked to private until the YouTube API audit passes.
    const wantedPublic = req.visibility === 'public' || Boolean(req.publishAt);
    const locked = wantedPublic && finalStatus && (finalStatus.privacyStatus !== 'public' && !finalStatus.publishAt);
    if (locked) warnings.push('YOUTUBE_LOCKED_PRIVATE: YouTube kept this video private — the API project needs the (free) YouTube API audit before automatic public publishing works');
    if (req.thumbnailPath) {
      const r = await this.o.fetchImpl(`${API}/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}&uploadType=media`, {
        method: 'POST', headers: await this.auth({ 'content-type': 'image/png' }), body: readFileSync(req.thumbnailPath),
      });
      if (!r.ok) warnings.push(`Thumbnail not set (HTTP ${r.status}) — custom thumbnails need a phone-verified channel (youtube.com/verify)`);
    }
    const tracks = [
      ...(req.captionsPath ? [{ path: req.captionsPath, language: req.captionsLanguage ?? req.defaultLanguage, name: 'العربية' }] : []),
      ...(req.extraCaptions ?? []),
    ];
    for (const tr of tracks) {
      const boundary = `yas${Date.now()}${tr.language}`;
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ snippet: { videoId, language: tr.language, name: tr.name, isDraft: false } })}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
        readFileSync(tr.path),
        Buffer.from(`\r\n--${boundary}--`),
      ]);
      const r = await this.o.fetchImpl(`${API}/upload/youtube/v3/captions?part=snippet&uploadType=multipart`, {
        method: 'POST', headers: await this.auth({ 'content-type': `multipart/related; boundary=${boundary}` }), body,
      });
      if (!r.ok) warnings.push(`Captions (${tr.language}) not uploaded (HTTP ${r.status})`);
    }
    return { youtubeVideoId: videoId, visibility: req.visibility, publishAt: req.publishAt, warnings };
  }

  /**
   * Lifetime metrics from YouTube Analytics (data lags ~1–3 days). Impressions/CTR are not exposed by this API;
   * they are omitted rather than guessed.
   */
  async metrics(youtubeVideoId: string): Promise<Record<string, number>> {
    const q = new URLSearchParams({
      ids: 'channel==MINE',
      startDate: '2020-01-01',
      endDate: new Date().toISOString().slice(0, 10),
      metrics: 'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes,comments,shares,subscribersGained',
      filters: `video==${youtubeVideoId}`,
    });
    const res = await this.o.fetchImpl(`https://youtubeanalytics.googleapis.com/v2/reports?${q}`, { headers: await this.auth() });
    if (!res.ok) await this.fail(res, 'analytics.reports');
    const j = (await res.json()) as { columnHeaders?: { name: string }[]; rows?: number[][] };
    const row = j.rows?.[0] ?? [];
    const v = (name: string) => Number(row[(j.columnHeaders ?? []).findIndex((h) => h.name === name)] ?? 0);
    return {
      views: v('views'),
      watchTimeHours: Number((v('estimatedMinutesWatched') / 60).toFixed(2)),
      avgViewDurationSec: v('averageViewDuration'),
      avgPercentViewed: Number((v('averageViewPercentage') / 100).toFixed(3)),
      likes: v('likes'),
      comments: v('comments'),
      shares: v('shares'),
      subscribersGained: v('subscribersGained'),
    };
  }
}
