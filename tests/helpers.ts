import { fileURLToPath } from 'node:url';
import { createContext, type CreateContextOptions } from '../src/context.ts';
import { silentLogger } from '../src/core/logger.ts';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

export function testContext(opts: CreateContextOptions & { env?: Record<string, string> } = {}) {
  const ctx = createContext({
    rootDir: ROOT,
    logger: opts.logger ?? silentLogger,
    sleep: async () => {},
    llm: opts.llm,
    envOverrides: { DATABASE_URL: 'sqlite::memory:', DRY_RUN: 'true', ...(opts.env ?? {}) },
  });
  // The live channel may be Shorts-only; tests also cover the long-video path (2 a week).
  ctx.config.channel.publishing.longPerWeek = 2;
  ctx.config.channel.niche = 'business-stories'; // generic pipeline tests; the phone library has its own tests
  return ctx;
}

/**
 * Mock voices render silence, which the media gates (rightly) never let through. Tests of the human
 * approval/publishing flow stand in a measured render that passes those gates — as a real voice would.
 */
export function measuredRender(ctx: ReturnType<typeof testContext>, videoId: string, extra: Record<string, unknown> = {}) {
  const prev = ctx.repos.artifacts.latest<Record<string, any>>(videoId, 'render')?.data ?? {};
  ctx.repos.artifacts.save({
    videoId, kind: 'render', agent: 'test',
    data: {
      videoPath: '/tmp/v.mp4', thumbnailPath: '/tmp/t.png', captionsPath: '', durationSec: 120, size: { width: 1920, height: 1080 },
      scenes: [{ n: 1, start: 0, duration: 30, audioPath: '', visual: 'image:x' }], shorts: [], visualMode: 'stock',
      assets: [{ id: 'img', kind: 'image', path: '/tmp/i.jpg', license: 'pexels', source: 'pexels', aiGenerated: false }],
      ...prev,
      voice: { provider: 'gemini-tts', voice: 'Charon (gemini-tts)', synthetic: true },
      measurements: { audio: { meanDb: -18, maxDb: -2 }, audioScore: 85, visualScore: 90, subtitleAccuracy: 100, avSyncDiffSec: 0, notes: ['12 shots (one per sentence, ~4.0s each); 12 with stock footage.'] },
      ...extra,
    },
  });
}
