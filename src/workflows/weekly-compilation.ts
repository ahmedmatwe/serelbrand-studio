/**
 * Weekly long video: the week's published Shorts stitched into one widescreen (16:9) video, each vertical Short in
 * the middle over a blurred copy of itself, with a chapter per Short. It reaches desktop/TV viewers and adds watch
 * hours (the 4,000-hour path to monetisation). Built on Friday evenings from the Shorts the workflow kept as
 * artifacts (data/weekly-in/<artifact>/<videoId>/short-N.mp4); once per week.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import type { AgentContext } from '../agents/base.ts';
import { allPosts } from '../analytics/learner.ts';
import { ffmpeg, probeDuration } from '../media/ffmpeg.ts';

export interface WeeklyClip { path: string; title: string; publishAt: string }

/** Every file under `dir`, keyed "<videoId>/<file>". */
function index(dir: string, out = new Map<string, string>()): Map<string, string> {
  for (const f of existsSync(dir) ? readdirSync(dir) : []) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) index(p, out);
    else if (f.endsWith('.mp4')) out.set(`${basename(dir)}/${f}`, p);
  }
  return out;
}

const clean = (t: string | null | undefined) => (t ?? '').replace(/\s*#Shorts$/i, '').trim();

/** This week's published YouTube Shorts that have their file, oldest first, one per topic. */
export function weekClips(ctx: AgentContext, inDir: string, now = new Date()): WeeklyClip[] {
  const files = index(inDir);
  const seen = new Set<string>();
  const out: WeeklyClip[] = [];
  const posts = allPosts(ctx).filter((p) => p.platform === 'youtube' && p.video_id && new Date(p.publish_at) <= now && now.getTime() - new Date(p.publish_at).getTime() < 7 * 86_400_000);
  for (const p of posts) {
    const title = clean(p.title);
    if (!title || seen.has(title)) continue;
    const shorts = ctx.repos.artifacts.latest<{ shorts?: { path: string; title: string; heldReason?: string }[] }>(p.video_id!, 'render')?.data.shorts ?? [];
    const sh = shorts.find((s) => clean(s.title) === title && !s.heldReason);
    const file = sh && files.get(`${p.video_id}/${basename(sh.path)}`);
    if (!file) continue;
    seen.add(title);
    out.push({ path: file, title, publishAt: p.publish_at });
  }
  return out;
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** YouTube chapters (first at 0:00, each ≥ 10 s). */
export function chapters(clips: { title: string; durationSec: number }[]): string[] {
  let t = 0;
  return clips.map((c) => { const line = `${mmss(t)} ${c.title}`; t += c.durationSec; return line; });
}

/** 1920×1080: the vertical Short centred over a darkened, blurred copy of itself; all clips joined. */
export async function stitch(clips: WeeklyClip[], out: string): Promise<number[]> {
  const durations = await Promise.all(clips.map((c) => probeDuration(c.path)));
  const parts = clips.map((_, i) =>
    `[${i}:v]split[a${i}][b${i}];[a${i}]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,boxblur=40:4,eq=brightness=-0.3:saturation=0.7[g${i}];` +
    `[b${i}]scale=-2:1080[f${i}];[g${i}][f${i}]overlay=(W-w)/2:0,setsar=1,fps=30,format=yuv420p[v${i}];` +
    `[${i}:a]aresample=48000,aformat=channel_layouts=stereo[s${i}]`);
  const join_ = clips.map((_, i) => `[v${i}][s${i}]`).join('') + `concat=n=${clips.length}:v=1:a=1[v][a]`;
  await ffmpeg([...clips.flatMap((c) => ['-i', c.path]), '-filter_complex', [...parts, join_].join(';'), '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out], { timeoutMs: 60 * 60_000 });
  return durations;
}

const Meta = z.object({ title: z.string().min(10).max(95), intro: z.string().max(300) });

export async function weeklyCompilation(ctx: AgentContext, inDir: string, outDir: string, now = new Date()): Promise<{ youtubeVideoId?: string; clips: number; reason?: string }> {
  const clips = weekClips(ctx, inDir, now);
  if (clips.length < 4) return { clips: clips.length, reason: 'less than 4 Shorts this week' };
  const out = join(outDir, 'weekly.mp4');
  const durations = await stitch(clips, out);
  const chap = chapters(clips.map((c, i) => ({ title: c.title, durationSec: durations[i]! })));
  const fallback = { title: `${clips.length} سر للموبايل لازم تعرفهم | تجميعة الأسبوع`, intro: 'كل أسرار الأسبوع في فيديو واحد. احفظه وابعته لحد محتاجه.' };
  const r = await ctx.providers.llm.generateJson({
    task: 'weekly.meta', tier: 'light',
    system: 'Title (≤ 90 chars, Egyptian Arabic, curiosity, honest, include the number of tips) and a 1–2 sentence intro for a weekly compilation video of the channel "سر الموبايل" built from these Shorts. No clickbait lies, no emojis spam. JSON only.',
    prompt: JSON.stringify({ count: clips.length, shorts: clips.map((c) => c.title) }),
    schema: Meta, maxOutputTokens: 600,
  }).then((x) => x.data as z.infer<typeof Meta>).catch(() => fallback);
  const description = [r.intro, '', '⏱️ الأسرار:', ...chap, '', 'تابع القناة لسر جديد كل يوم 🔔', '', '#سر_الموبايل #أسرار_الموبايل #اندرويد #ايفون'].join('\n');
  const res = await ctx.providers.youtube.upload({
    videoPath: out, title: r.title, description, tags: ['سر الموبايل', 'أسرار الموبايل', 'حيل الموبايل', 'اندرويد', 'ايفون', 'تجميعة'],
    visibility: 'public', containsSyntheticMedia: true, defaultLanguage: ctx.config.channel.language, categoryId: '28',
  });
  return { youtubeVideoId: res.youtubeVideoId, clips: clips.length };
}
