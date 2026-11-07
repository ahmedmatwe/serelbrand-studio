import { downloadToCache } from './download.ts';
import { ProviderError } from '../../core/errors.ts';
import { RateLimiter } from '../../core/retry.ts';
import type { MediaAsset, StockProvider, StockSearchOptions } from '../media.ts';

interface PexelsVideo {
  id: number; width: number; height: number; duration: number; url: string; image?: string;
  user: { name: string; url: string };
  video_files: { id: number; quality: string | null; file_type: string; width: number | null; height: number | null; link: string }[];
}
interface PexelsPhoto {
  id: number; width: number; height: number; url: string; photographer: string; photographer_url: string; alt?: string;
  src: Record<'original' | 'large2x' | 'large' | 'landscape' | 'portrait', string>;
}

const ALLOWED_DOWNLOAD_HOSTS = /(^|\.)pexels\.com$/i;

/** Picks the MP4 rendition closest to (and preferably not below) the target width. */
export function pickVideoFile(files: PexelsVideo['video_files'], targetWidth: number) {
  const mp4 = files.filter((f) => f.file_type === 'video/mp4' && f.width && f.link);
  const atLeast = mp4.filter((f) => f.width! >= targetWidth).sort((a, b) => a.width! - b.width!);
  return atLeast[0] ?? mp4.sort((a, b) => b.width! - a.width!)[0];
}

/**
 * Pexels stock provider (free API: https://www.pexels.com/api/).
 * License: free to use and modify, attribution appreciated; the API guidelines ask to credit Pexels and the creator.
 * Rate limit: 200 req/hour — enforced locally so we never hammer the API.
 */
export class PexelsStock implements StockProvider {
  readonly name = 'pexels';
  private readonly key: string;
  private readonly fetchImpl: typeof fetch;
  private readonly limiter: RateLimiter;

  constructor(apiKey: string, opts: { fetchImpl?: typeof fetch; limiter?: RateLimiter } = {}) {
    if (!apiKey) throw new ProviderError('pexels', 'PEXELS_API_KEY is missing', false);
    this.key = apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.limiter = opts.limiter ?? new RateLimiter(10, 200 / 3600);
  }

  private async get<T>(url: string): Promise<T> {
    await this.limiter.take();
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers: { Authorization: this.key }, signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      throw new ProviderError('pexels', `Network error: ${(err as Error).message}`, true, { cause: err });
    }
    if (!res.ok) throw new ProviderError('pexels', `HTTP ${res.status} for ${new URL(url).pathname}`, res.status === 429 || res.status >= 500);
    return (await res.json()) as T;
  }

  async search(query: string, kind: 'image' | 'video', opts: StockSearchOptions = {}): Promise<MediaAsset[]> {
    const q = new URLSearchParams({ query, per_page: String(opts.perPage ?? 10), orientation: opts.orientation ?? 'landscape' });
    const target = opts.targetWidth ?? 1920;
    if (kind === 'video') {
      // Documented path has varied between /videos/search and /v1/videos/search — try both.
      const data = await this.get<{ videos: PexelsVideo[] }>(`https://api.pexels.com/videos/search?${q}`).catch((e: Error) => {
        if (/HTTP 404/.test(e.message)) return this.get<{ videos: PexelsVideo[] }>(`https://api.pexels.com/v1/videos/search?${q}`);
        throw e;
      });
      return data.videos.flatMap((v) => {
        const f = pickVideoFile(v.video_files, target);
        return f ? [{
          id: `pexels-video-${v.id}`, kind: 'video' as const, path: f.link, license: 'pexels' as const, source: 'pexels',
          attribution: `${v.user.name} on Pexels`, pageUrl: v.url, authorUrl: v.user.url, width: f.width!, height: f.height!, durationSec: v.duration, aiGenerated: false, tags: slugTags(v.url), previewUrl: v.image,
        }] : [];
      });
    }
    const data = await this.get<{ photos: PexelsPhoto[] }>(`https://api.pexels.com/v1/search?${q}`);
    return data.photos.map((p) => ({
      id: `pexels-photo-${p.id}`, kind: 'image' as const, path: target > 1200 ? p.src.large2x : p.src.large, license: 'pexels' as const, source: 'pexels',
      attribution: `${p.photographer} on Pexels`, pageUrl: p.url, authorUrl: p.photographer_url, width: p.width, height: p.height, aiGenerated: false, tags: slugTags(p.url), previewUrl: p.src.landscape,
    }));
  }

  /** Streams the file to the cache. Only Pexels hosts are allowed. */
  async download(asset: MediaAsset, cacheDir: string): Promise<string> {
    const url = new URL(asset.path);
    const ext = asset.kind === 'video' ? 'mp4' : (url.pathname.split('.').pop() ?? 'jpg').toLowerCase().replace(/[^a-z]/g, '') || 'jpg';
    return downloadToCache({ provider: 'pexels', url: asset.path, file: `${asset.id}-${asset.width ?? 0}.${ext}`, cacheDir, allowedHosts: ALLOWED_DOWNLOAD_HOSTS, fetchImpl: this.fetchImpl });
  }
}

/** Pexels page URLs carry a description slug: /video/a-man-typing-on-laptop-123/ → [a, man, typing, …]. */
const slugTags = (url?: string) => (url?.split('/').filter(Boolean).pop() ?? '').split('-').filter((w) => w && !/^\d+$/.test(w)).map((w) => w.toLowerCase());
