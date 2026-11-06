/**
 * YouTube-style thumbnail (1280×720): real, colour-graded photo + huge outlined Arabic text on a darkened side
 * + a red attention ring + the channel badge. Falls back to a gradient only when no photo is found.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentContext } from '../agents/base.ts';
import type { ThumbnailConcept } from '../agents/schemas.ts';
import type { MediaAsset } from '../providers/media.ts';
import { assColor, assText } from './ass.ts';
import { ffmpeg, filterPath } from './ffmpeg.ts';
import { pickRelevant, queriesForSentences, queryParts } from './shots.ts';

const W = 1280, H = 720;

function circle(cx: number, cy: number, r: number): string {
  const k = 0.5523 * r, f = Math.round;
  return `m ${f(cx)} ${f(cy - r)} b ${f(cx + k)} ${f(cy - r)} ${f(cx + r)} ${f(cy - k)} ${f(cx + r)} ${f(cy)} b ${f(cx + r)} ${f(cy + k)} ${f(cx + k)} ${f(cy + r)} ${f(cx)} ${f(cy + r)} b ${f(cx - k)} ${f(cy + r)} ${f(cx - r)} ${f(cy + k)} ${f(cx - r)} ${f(cy)} b ${f(cx - r)} ${f(cy - k)} ${f(cx - k)} ${f(cy - r)} ${f(cx)} ${f(cy - r)}`;
}

/** Splits 4+ word texts into two balanced lines. */
export function thumbLines(text: string): string[] {
  const w = text.trim().split(/\s+/);
  if (w.length <= 3) return [w.join(' ')];
  const mid = Math.ceil(w.length / 2);
  return [w.slice(0, mid).join(' '), w.slice(mid).join(' ')];
}

export function thumbnailAss(o: { text: string; font: string; accent: string; brand: string; hasPhoto: boolean }): string {
  const lines = thumbLines(o.text);
  const size = lines.length === 1 && o.text.length <= 12 ? 170 : 128;
  const header = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, 'WrapStyle: 2', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // Main text: right side (Arabic reads from the right), heavy black outline + shadow.
    `Style: Big,${o.font},${size},${assColor(o.accent)},${assColor(o.accent)},${assColor('#000000')},${assColor('#000000', 0x40)},-1,0,0,0,100,100,0,0,1,10,7,6,40,60,0,-1`,
    `Style: Badge,${o.font},34,${assColor('#FFFFFF')},${assColor('#FFFFFF')},${assColor('#E53935')},${assColor('#E53935')},-1,0,0,0,100,100,0,0,3,10,0,9,30,30,28,-1`,
    `Style: D,${o.font},10,${assColor('#FFFFFF')},${assColor('#FFFFFF')},${assColor('#E53935')},${assColor('#000000')},0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,-1`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const ev: string[] = [];
  ev.push(`Dialogue: 2,0:00:00.00,0:00:05.00,Big,,0,0,0,,${lines.map((l) => assText(l)).join('\\N')}`);
  ev.push(`Dialogue: 2,0:00:00.00,0:00:05.00,Badge,,0,0,0,,${assText(o.brand)}`);
  // Red attention ring on the photo side (outline only: transparent fill, thick red border).
  if (o.hasPhoto) ev.push(`Dialogue: 1,0:00:00.00,0:00:05.00,D,,0,0,0,,{\\an7\\pos(0,0)\\1a&HFF&\\3c${assColor('#E53935')}\\bord12\\shad0\\p1}${circle(330, 380, 175)}{\\p0}`);
  return [...header, ...ev, ''].join('\n');
}

export async function renderThumbnail(ctx: AgentContext, o: {
  dir: string; videoId: string; concept: ThumbnailConcept; title: string; palette: string[]; font: string; used: Set<string>; notes: string[];
}): Promise<{ path: string; asset?: MediaAsset }> {
  const out = resolve(o.dir, 'thumbnail.png');
  const assPath = resolve(o.dir, 'thumb.ass');
  const stock = ctx.providers.stock;
  let photo: { path: string; asset: MediaAsset } | undefined;
  // 1) A custom AI image made for this video (Cloudflare FLUX, free) — no text, no real faces/logos.
  if (ctx.providers.image.name !== 'mock-image' && o.concept.aiPrompt) {
    try {
      const a = await ctx.providers.image.generate(`${o.concept.aiPrompt}. Composition: main subject on the left third, darker empty area on the right for a headline`, resolve(o.dir, 'thumb-ai.jpg'));
      photo = { path: a.path, asset: a };
      o.notes.push('Thumbnail: custom AI background (Cloudflare FLUX).');
    } catch (err) {
      o.notes.push(`Thumbnail AI image failed (${(err as Error).message.slice(0, 80)}) — using a stock photo.`);
    }
  }
  // 2) Otherwise a relevant stock photo.
  if (!photo && stock.download) {
    const [joined] = await queriesForSentences(ctx, [`${o.concept.mainVisual} — ${o.title}`], 'business office', o.videoId, o.title);
    let pick: MediaAsset | undefined;
    for (const query of queryParts(joined!)) {
      const imgs = await stock.search(query, 'image', { orientation: 'landscape', targetWidth: 1920, perPage: 10 }).catch(() => []);
      const vids = imgs.length ? [] : await stock.search(query, 'video', { orientation: 'landscape', targetWidth: 1920, perPage: 5 }).catch(() => []);
      pick = pickRelevant([...imgs, ...vids], query, o.used);
      if (pick) break;
    }
    if (pick) {
      try {
        const p = await stock.download(pick, resolve(ctx.config.rootDir, 'data/stock-cache'));
        photo = { path: p, asset: { ...pick, path: p } };
      } catch { /* fall back to gradient */ }
    }
  }
  writeFileSync(assPath, thumbnailAss({ text: o.concept.text, font: o.font, accent: o.palette[2] && o.palette[2] !== '#FFFFFF' ? o.palette[2] : '#FFD400', brand: 'سر البراند', hasPhoto: Boolean(photo) }));
  const grade = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},eq=contrast=1.15:saturation=1.35:brightness=0.02,vignette=PI/5,drawbox=x=600:y=0:w=680:h=${H}:color=black@0.45:t=fill,drawbox=x=540:y=0:w=60:h=${H}:color=black@0.22:t=fill`;
  if (photo) {
    const src = photo.asset.kind === 'video' ? ['-ss', '1', '-i', photo.path] : ['-i', photo.path];
    await ffmpeg([...src, '-vf', `${grade},subtitles=filename='${filterPath(assPath)}'`, '-frames:v', '1', '-update', '1', out]);
  } else {
    await ffmpeg(['-f', 'lavfi', '-i', `gradients=s=${W}x${H}:c0=${o.palette[0]!.replace('#', '0x')}:c1=${(o.palette[1] ?? '#000000').replace('#', '0x')}:d=1:seed=7`, '-vf', `subtitles=filename='${filterPath(assPath)}'`, '-frames:v', '1', '-update', '1', out]);
    o.notes.push('Thumbnail: no matching photo found — gradient background used.');
  }
  return { path: out, asset: photo?.asset };
}
