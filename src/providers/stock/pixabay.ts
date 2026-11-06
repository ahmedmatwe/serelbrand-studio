import { ProviderError } from '../../core/errors.ts';
import { RateLimiter } from '../../core/retry.ts';
import type { MediaAsset, StockProvider, StockSearchOptions } from '../media.ts';
import { downloadToCache } from './download.ts';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CACHE_TTL_MS = 24 * 3600_000;

type Rendition = { url: string; width: number; height: number; size: number };
interface PixabayVideo { id: number; pageURL: string; tags?: string; duration: number; user: string; user_id: number; videos: Partial<Record<'large' | 'medium' | 'small' | 'tiny', Rendition>> }
interface PixabayImage { id: number; pageURL: string; tags?: string; largeImageURL: string; imageWidth: number; imageHeight: number; user: string; user_id: number }

/** Smallest rendition at least `target` wide, else the largest available. Empty URLs are skipped. */
export function pickRendition(v: PixabayVideo['videos'], target: number): Rendition | undefined {
  const all = Object.values(v).filter((r): r is Rendition => Boolean(r?.url) && (r?.width ?? 0) > 0);
  return all.filter((r) => r.width >= target).sort((a, b) => a.width - b.width)[0] ?? all.sort((a, b) => b.width - a.width)[0];
}

/**
 * Pixabay stock provider (free API: https://pixabay.com/api/docs/).
 * Content License: free for commercial use, no attribution required — the API asks to show the source,
 * so credits are added to the description. Files are downloaded (no hotlinking), responses would be cached 24h.
 * The API key must travel in the query string (Pixabay's design); it is never logged — errors only show the path.
 */
export class PixabayStock implements StockProvider {
  readonly name = 'pixabay';
  private readonly key: string;
  private readonly fetchImpl: typeof fetch;
  private readonly limiter: RateLimiter;

  private readonly cacheDir?: string;

  constructor(apiKey: string, opts: { fetchImpl?: typeof fetch; limiter?: RateLimiter; cacheDir?: string } = {}) {
    if (!apiKey) throw new ProviderError('pixabay', 'PIXABAY_API_KEY is missing', false);
    this.key = apiKey;
    this.cacheDir = opts.cacheDir;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.limiter = opts.limiter ?? new RateLimiter(10, 60 / 60); // well under 100 req / 60 s
  }

  /** Pixabay requires API responses to be cached for 24 hours. The cache key never contains the API key. */
  private async get<T>(path: string, params: Record<string, string>): Promise<T> {
    const cacheFile = this.cacheDir ? resolve(this.cacheDir, `pixabay-search-${createHash('sha256').update(path + JSON.stringify(params)).digest('hex').slice(0, 24)}.json`) : undefined;
    if (cacheFile && existsSync(cacheFile) && Date.now() - statSync(cacheFile).mtimeMs < CACHE_TTL_MS) return JSON.parse(readFileSync(cacheFile, 'utf8')) as T;
    const data = await this.fetchJson<T>(path, params);
    if (cacheFile) { mkdirSync(this.cacheDir!, { recursive: true }); writeFileSync(cacheFile, JSON.stringify(data)); }
    return data;
  }

  private async fetchJson<T>(path: string, params: Record<string, string>): Promise<T> {
    await this.limiter.take();
    const url = `https://pixabay.com${path}?${new URLSearchParams({ key: this.key, ...params })}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      throw new ProviderError('pixabay', `Network error on ${path}`, true, { cause: err });
    }
    if (!res.ok) throw new ProviderError('pixabay', `HTTP ${res.status} for ${path}`, res.status === 429 || res.status >= 500);
    return (await res.json()) as T;
  }

  async search(query: string, kind: 'image' | 'video', opts: StockSearchOptions = {}): Promise<MediaAsset[]> {
    const target = opts.targetWidth ?? 1920;
    const base = { q: query.slice(0, 100), per_page: String(Math.max(3, opts.perPage ?? 10)), safesearch: 'true' };
    if (kind === 'video') {
      const data = await this.get<{ hits: PixabayVideo[] }>('/api/videos/', { ...base, video_type: 'film' });
      return data.hits.flatMap((v) => {
        const r = pickRendition(v.videos, target);
        return r ? [{
          id: `pixabay-video-${v.id}`, kind: 'video' as const, path: r.url, license: 'pixabay' as const, source: 'pixabay',
          attribution: `${v.user} on Pixabay`, pageUrl: v.pageURL, authorUrl: `https://pixabay.com/users/${encodeURIComponent(v.user)}-${v.user_id}/`,
          width: r.width, height: r.height, durationSec: v.duration, aiGenerated: false, tags: splitTags(v.tags),
        }] : [];
      });
    }
    const data = await this.get<{ hits: PixabayImage[] }>('/api/', { ...base, image_type: 'photo', orientation: opts.orientation === 'portrait' ? 'vertical' : 'horizontal', min_width: '1280' });
    return data.hits.map((h) => ({
      id: `pixabay-photo-${h.id}`, kind: 'image' as const, path: h.largeImageURL, license: 'pixabay' as const, source: 'pixabay',
      attribution: `${h.user} on Pixabay`, pageUrl: h.pageURL, authorUrl: `https://pixabay.com/users/${encodeURIComponent(h.user)}-${h.user_id}/`,
      width: h.imageWidth, height: h.imageHeight, aiGenerated: false, tags: splitTags(h.tags),
    }));
  }

  async download(asset: MediaAsset, cacheDir: string): Promise<string> {
    const ext = asset.kind === 'video' ? 'mp4' : (new URL(asset.path).pathname.split('.').pop() ?? 'jpg').toLowerCase().replace(/[^a-z]/g, '') || 'jpg';
    return downloadToCache({ provider: 'pixabay', url: asset.path, file: `${asset.id}-${asset.width ?? 0}.${ext}`, cacheDir, allowedHosts: /(^|\.)pixabay\.com$/i, fetchImpl: this.fetchImpl });
  }
}

const splitTags = (t?: string) => (t ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
