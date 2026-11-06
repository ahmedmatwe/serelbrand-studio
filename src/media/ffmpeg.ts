import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { StudioError } from '../core/errors.ts';

const run = promisify(execFile);

/** Path of the bundled FFmpeg binary (npm `ffmpeg-static`), overridable with FFMPEG_PATH. */
export function ffmpegPath(): string {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const p = createRequire(import.meta.url)('ffmpeg-static') as string | null;
  if (!p) throw new StudioError('FFMPEG_MISSING', 'ffmpeg-static has no binary for this platform. Set FFMPEG_PATH.');
  return p;
}

/** Runs FFmpeg with an argument array (no shell). Returns stderr, where FFmpeg writes its diagnostics. */
export async function ffmpeg(args: string[], opts: { timeoutMs?: number } = {}): Promise<string> {
  try {
    const { stderr } = await run(ffmpegPath(), ['-hide_banner', '-y', ...args], { timeout: opts.timeoutMs ?? 30 * 60_000, maxBuffer: 64 * 1024 * 1024 });
    return stderr;
  } catch (err) {
    const e = err as Error & { stderr?: string };
    const tail = (e.stderr ?? e.message).split('\n').filter(Boolean).slice(-6).join(' | ');
    throw new StudioError('FFMPEG_FAILED', `ffmpeg failed: ${tail}`, false, { cause: err });
  }
}

/** Duration in seconds, parsed from FFmpeg's input banner (ffprobe is not bundled). */
export async function probeDuration(path: string): Promise<number> {
  let stderr = '';
  try {
    await run(ffmpegPath(), ['-hide_banner', '-i', path]);
  } catch (err) {
    stderr = (err as { stderr?: string }).stderr ?? ''; // ffmpeg exits 1 without an output file — expected
  }
  const m = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  if (!m) throw new StudioError('PROBE_FAILED', `Cannot read duration of ${path}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export interface VolumeStats { meanDb: number; maxDb: number }

/** Mean/peak volume via `volumedetect` — used to verify the voice-over is not silent or clipping. */
export async function volumeStats(path: string): Promise<VolumeStats> {
  const err = await ffmpeg(['-i', path, '-af', 'volumedetect', '-vn', '-f', 'null', '-']);
  const mean = err.match(/mean_volume:\s*(-?[\d.]+|-inf) dB/);
  const max = err.match(/max_volume:\s*(-?[\d.]+|-inf) dB/);
  const num = (s?: string) => (!s || s === '-inf' ? -Infinity : Number(s));
  return { meanDb: num(mean?.[1]), maxDb: num(max?.[1]) };
}

/** Escapes a path for use inside an FFmpeg filtergraph argument (e.g. subtitles=...). */
export function filterPath(p: string): string {
  return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/,/g, '\\,').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}
