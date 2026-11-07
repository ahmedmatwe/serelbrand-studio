/**
 * Real photos of the actual companies, founders, products and places from Wikimedia Commons (free, no key).
 * Only licenses that allow reuse in a monetized video with attribution are accepted:
 * public domain, CC0 and CC BY — never share-alike (BY-SA), non-commercial or non-free files.
 */
import { ProviderError } from '../../core/errors.ts';
import { RateLimiter } from '../../core/retry.ts';
import type { MediaAsset, StockProvider, StockSearchOptions } from '../media.ts';
import { downloadToCache } from './download.ts';

const API = 'https://commons.wikimedia.org/w/api.php';
const UA = 'SerElBrandStudio/1.0 (YouTube documentary channel; uses CC/PD images with attribution)';

interface CommonsPage {
  title: string;
  imageinfo?: { thumburl?: string; url: string; width: number; height: number; descriptionurl: string; extmetadata?: Record<string, { value?: string }> }[];
}

const stripHtml = (s = '') => s.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();

/** Accepts PD / CC0 / CC BY only. */
export function reusableLicense(shortName: string): boolean {
  const l = shortName.toLowerCase();
  if (/sa|nc|nd|non-?free|fair use|copyrighted/.test(l.replace(/public domain/, ''))) return false;
  return /public domain|^pd|cc0|cc[- ]by( |-|$)|cc by \d/.test(l);
}

export class WikimediaStock implements StockProvider {
  readonly name = 'wikimedia';
  private readonly fetchImpl: typeof fetch;
  private readonly limiter: RateLimiter;
  constructor(opts: { fetchImpl?: typeof fetch; limiter?: RateLimiter } = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.limiter = opts.limiter ?? new RateLimiter(5, 2);
  }

  async search(query: string, kind: 'image' | 'video', opts: StockSearchOptions = {}): Promise<MediaAsset[]> {
    if (kind !== 'image') return [];
    await this.limiter.take();
    const params = new URLSearchParams({
      action: 'query', format: 'json', origin: '*', generator: 'search', gsrnamespace: '6', gsrlimit: String(opts.perPage ?? 10),
      gsrsearch: `${query} filetype:bitmap`, prop: 'imageinfo', iiprop: 'url|size|extmetadata', iiurlwidth: String(opts.targetWidth ?? 1920),
    });
    const res = await this.fetchImpl(`${API}?${params}`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30_000) })
      .catch((err: Error) => { throw new ProviderError('wikimedia', `Network error: ${err.message}`, true); });
    if (!res.ok) throw new ProviderError('wikimedia', `HTTP ${res.status}`, res.status === 429 || res.status >= 500);
    const data = (await res.json()) as { query?: { pages?: Record<string, CommonsPage & { index?: number }> } };
    const pages = Object.values(data.query?.pages ?? {}).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return pages.flatMap((p) => {
      const ii = p.imageinfo?.[0];
      const md = ii?.extmetadata ?? {};
      const license = md.LicenseShortName?.value ?? '';
      if (!ii || !reusableLicense(license) || ii.width < 800) return [];
      const artist = stripHtml(md.Artist?.value) || 'Unknown author';
      const desc = stripHtml(md.ImageDescription?.value).slice(0, 300);
      return [{
        id: `wikimedia-${p.title}`, kind: 'image' as const, path: ii.thumburl ?? ii.url, license: 'licensed' as const, source: 'wikimedia',
        attribution: `${artist} — ${license}, via Wikimedia Commons`, pageUrl: ii.descriptionurl, width: ii.width, height: ii.height, aiGenerated: false,
        previewUrl: (ii.thumburl ?? ii.url).replace(/\/(\d+)px-/, '/400px-'),
        tags: `${p.title.replace(/^File:/, '').replace(/\.\w+$/, '')} ${desc}`.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1),
      }];
    });
  }

  async download(asset: MediaAsset, cacheDir: string): Promise<string> {
    const ext = (new URL(asset.path).pathname.split('.').pop() ?? 'jpg').toLowerCase().replace(/[^a-z]/g, '') || 'jpg';
    const safe = asset.id.replace(/[^\w.-]+/g, '_').slice(0, 120);
    return downloadToCache({ provider: 'wikimedia', url: asset.path, file: `${safe}.${ext}`, cacheDir, allowedHosts: /(^|\.)wikimedia\.org$/i, fetchImpl: this.fetchImpl, headers: { 'user-agent': UA } });
  }
}
