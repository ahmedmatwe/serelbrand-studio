/**
 * Cover image for every Short: the frame where the opening headline is fully on screen (big title + icon in motion
 * Shorts, the hook caption in stock ones). Used as the YouTube thumbnail (channel page, search, suggestions), the
 * Instagram Reel cover (grid + Reels tab) and the Facebook Reel thumbnail. No hosting needed: Instagram takes the
 * moment in the video, YouTube and Facebook take the uploaded image.
 */
import { ffmpeg } from './ffmpeg.ts';

/** Seconds into the Short where the first scene's headline has landed (after its entrance animation). */
export function coverTime(sh: { shotLog?: { start: number; duration: number }[]; durationSec?: number }): number {
  const first = sh.shotLog?.[0];
  const t = first ? first.start + Math.min(1.6, Math.max(0.9, first.duration * 0.6)) : 1.3;
  return Number(Math.min(t, Math.max(0.5, (sh.durationSec ?? 10) - 1)).toFixed(2));
}

/** Writes that frame as a JPEG, without the half-said caption (1080×1920, well under YouTube's 2 MB limit). */
export async function extractCover(video: string, sec: number, out: string): Promise<string> {
  // The running caption (bottom ~22%) is cut mid-sentence at any moment: keep the top (headline) sharp and
  // dissolve the bottom into a dark blur of the same frame.
  const f = "[0:v]split[a][b];[b]gblur=sigma=60,eq=brightness=-0.12[bg];" +
    "[a]crop=iw:ih*0.78:0:0,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(gt(Y,H-140),255*(H-Y)/140,255)'[top];[bg][top]overlay=0:0";
  await ffmpeg(['-ss', String(sec), '-i', video, '-filter_complex', f, '-frames:v', '1', '-q:v', '3', out], { timeoutMs: 60_000 });
  return out;
}
