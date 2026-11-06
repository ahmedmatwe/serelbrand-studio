import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ProviderError } from '../../core/errors.ts';

const MAX_DOWNLOAD_BYTES = 300 * 1024 * 1024;

/** Streams a stock file into the local cache (atomic rename). Only https + allow-listed hosts. */
export async function downloadToCache(o: { provider: string; url: string; file: string; cacheDir: string; allowedHosts: RegExp; fetchImpl: typeof fetch }): Promise<string> {
  const url = new URL(o.url);
  if (url.protocol !== 'https:' || !o.allowedHosts.test(url.hostname)) throw new ProviderError(o.provider, `Refusing to download from ${url.hostname}`, false);
  mkdirSync(o.cacheDir, { recursive: true });
  const out = resolve(o.cacheDir, o.file);
  if (existsSync(out) && statSync(out).size > 0) return out;
  const res = await o.fetchImpl(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok || !res.body) throw new ProviderError(o.provider, `Download failed: HTTP ${res.status}`, res.status >= 500);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_DOWNLOAD_BYTES) throw new ProviderError(o.provider, `File too large (${Math.round(len / 1e6)} MB)`, false);
  const tmp = out + '.part';
  try {
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
    renameSync(tmp, out);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw new ProviderError(o.provider, `Download failed: ${(err as Error).message}`, true, { cause: err });
  }
  return out;
}
