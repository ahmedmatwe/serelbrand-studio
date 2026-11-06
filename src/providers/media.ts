/**
 * Interfaces + offline mocks for media, trends and YouTube providers.
 * Real implementations are added in later phases behind the same interfaces.
 */

// ---------- Trends ----------
export interface TrendSignal {
  query: string;
  /** 0..100 relative search interest. */
  interest: number;
  /** -1 (falling) .. 1 (rising) */
  momentum: number;
  /** 0..100: how saturated the results are with strong competitors. */
  competition: number;
  relatedQuestions: string[];
}

export interface TrendsProvider {
  readonly name: string;
  signals(seedQueries: string[], country: string): Promise<TrendSignal[]>;
}

/** Deterministic pseudo-random numbers from a string, so mock data is stable across runs. */
export function seeded(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10_000) / 10_000;
}

export class MockTrends implements TrendsProvider {
  readonly name = 'mock-trends';
  async signals(seedQueries: string[], country: string): Promise<TrendSignal[]> {
    return seedQueries.map((q) => ({
      query: q,
      interest: Math.round(30 + seeded(q + country) * 70),
      momentum: Number((seeded('m' + q) * 2 - 1).toFixed(2)),
      competition: Math.round(20 + seeded('c' + q) * 70),
      relatedQuestions: [`ليه ${q}؟`, `إيه اللي حصل في ${q}؟`],
    }));
  }
}

// ---------- TTS ----------
export interface TTSResult { audioPath: string; durationSec: number; characters: number; voice: string }
export interface TTSProvider { readonly name: string; synthesize(text: string, outPath: string): Promise<TTSResult> }

export class MockTTS implements TTSProvider {
  readonly name = 'mock-tts';
  async synthesize(text: string, outPath: string): Promise<TTSResult> {
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    return { audioPath: outPath, durationSec: Math.round((words / 130) * 60), characters: text.length, voice: 'mock-arabic-male' };
  }
}

// ---------- Images / stock ----------
export type AssetLicense = 'generated-owned' | 'pexels' | 'pixabay' | 'cc0' | 'licensed' | 'unknown';
export interface MediaAsset {
  id: string;
  kind: 'image' | 'video' | 'music' | 'sfx' | 'voice';
  /** Local file path, or a remote download URL before download. */
  path: string;
  license: AssetLicense;
  source: string;
  attribution?: string;
  aiGenerated: boolean;
  /** Public page of the asset (used for credits). */
  pageUrl?: string;
  authorUrl?: string;
  width?: number;
  height?: number;
  durationSec?: number;
}

export interface ImageProvider { readonly name: string; generate(prompt: string, outPath: string): Promise<MediaAsset> }
export interface StockSearchOptions { orientation?: 'landscape' | 'portrait'; targetWidth?: number; perPage?: number }
export interface StockProvider {
  readonly name: string;
  search(query: string, kind: 'image' | 'video', opts?: StockSearchOptions): Promise<MediaAsset[]>;
  /** Downloads a search result to a local file (cached). Mocks may not support it. */
  download?(asset: MediaAsset, cacheDir: string): Promise<string>;
}

export class MockImage implements ImageProvider {
  readonly name = 'mock-image';
  async generate(prompt: string, outPath: string): Promise<MediaAsset> {
    return { id: `img_${Math.round(seeded(prompt) * 1e6)}`, kind: 'image', path: outPath, license: 'generated-owned', source: 'mock-image', aiGenerated: true };
  }
}

export class MockStock implements StockProvider {
  readonly name = 'mock-stock';
  async search(query: string, kind: 'image' | 'video'): Promise<MediaAsset[]> {
    return [1, 2, 3].map((i) => ({
      id: `stk_${i}_${Math.round(seeded(query) * 1e6)}`,
      kind,
      path: `mock://stock/${encodeURIComponent(query)}/${i}`,
      license: 'pexels' as const,
      source: 'mock-pexels',
      attribution: 'Mock Pexels contributor',
      aiGenerated: false,
    }));
  }
}

// ---------- YouTube ----------
export type Visibility = 'private' | 'unlisted' | 'public';
export interface UploadRequest {
  videoPath: string;
  thumbnailPath?: string;
  title: string;
  description: string;
  tags: string[];
  visibility: Visibility;
  publishAt?: string;
  playlistId?: string;
  containsSyntheticMedia: boolean;
  categoryId?: string;
  defaultLanguage: string;
  captionsPath?: string;
  captionsLanguage?: string;
}
export interface UploadResult { youtubeVideoId: string; visibility: Visibility; publishAt?: string; warnings?: string[] }

export interface YouTubeProvider {
  readonly name: string;
  upload(req: UploadRequest): Promise<UploadResult>;
  /** Returns cumulative metrics for a video. */
  metrics(youtubeVideoId: string, hoursSincePublish: number): Promise<Record<string, number>>;
}

export class MockYouTube implements YouTubeProvider {
  readonly name = 'mock-youtube';
  uploads: UploadRequest[] = [];
  async upload(req: UploadRequest): Promise<UploadResult> {
    this.uploads.push(req);
    return { youtubeVideoId: `mock_${Math.round(seeded(req.title) * 1e9)}`, visibility: req.visibility, publishAt: req.publishAt };
  }
  async metrics(id: string, hours: number): Promise<Record<string, number>> {
    const q = 0.5 + seeded(id); // per-video "quality" factor
    const impressions = Math.round(400 * q * Math.log2(hours + 1) * 10);
    const ctr = Number((0.03 + seeded('ctr' + id) * 0.06).toFixed(4));
    const views = Math.round(impressions * ctr);
    const avgViewDurationSec = Math.round(150 + seeded('avd' + id) * 200);
    return {
      impressions,
      ctr,
      views,
      avgViewDurationSec,
      avgPercentViewed: Number((avgViewDurationSec / 600).toFixed(3)),
      watchTimeHours: Number(((views * avgViewDurationSec) / 3600).toFixed(2)),
      likes: Math.round(views * 0.04),
      comments: Math.round(views * 0.006),
      shares: Math.round(views * 0.003),
      subscribersGained: Math.round(views * 0.01),
    };
  }
}
