/**
 * AI images on Cloudflare Workers AI (FLUX.1 schnell) — free daily allowance (~10k neurons/day ≈ hundreds of
 * 1024px images). Used for thumbnail backgrounds; the account id + API token come from env/secrets.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ProviderError } from '../../core/errors.ts';
import { withRetry } from '../../core/retry.ts';
import type { ImageProvider, MediaAsset } from '../media.ts';

/** Rules added to every prompt: no text (we draw our own), no real people's likeness, no logos. */
export const SAFE_SUFFIX = ', photorealistic cinematic photograph, dramatic lighting, high detail, no text, no letters, no watermark, no logos, no real celebrity likeness';

export class CloudflareImage implements ImageProvider {
  readonly name = 'cloudflare-flux';
  private readonly o: { accountId: string; token: string; model: string; fetchImpl: typeof fetch; sleep?: (ms: number) => Promise<void> };
  constructor(o: { accountId: string; token: string; model?: string; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> }) {
    if (!o.accountId || !o.token) throw new ProviderError('cloudflare', 'CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required', false);
    this.o = { model: '@cf/black-forest-labs/flux-1-schnell', fetchImpl: fetch, ...o };
  }

  async generate(prompt: string, outPath: string): Promise<MediaAsset> {
    const run = async () => {
      const res = await this.o.fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.o.accountId)}/ai/run/${this.o.model}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.o.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: (prompt.slice(0, 1500) + SAFE_SUFFIX).slice(0, 2048), steps: 8 }),
        signal: AbortSignal.timeout(120_000),
      }).catch((err: Error) => { throw new ProviderError('cloudflare', `Network error: ${err.message}`, true); });
      const j = (await res.json().catch(() => ({}))) as { result?: { image?: string }; errors?: { message?: string }[] };
      // Never echo the token: only status + Cloudflare's own message.
      if (!res.ok || !j.result?.image) throw new ProviderError('cloudflare', `HTTP ${res.status}: ${j.errors?.[0]?.message ?? 'no image returned'}`, res.status === 429 || res.status >= 500);
      return Buffer.from(j.result.image, 'base64');
    };
    const img = await withRetry(run, { attempts: 3, baseDelayMs: 5_000, sleep: this.o.sleep });
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, img);
    return { id: `cf-${Date.now()}`, kind: 'image', path: outPath, license: 'generated-owned', source: 'cloudflare-flux', aiGenerated: true };
  }
}
