/**
 * Generates channel branding (profile picture, banner, watermark) locally with FFmpeg + libass.
 * Run: node --no-warnings scripts/make-branding.ts
 * All artwork is original (drawn shapes + system Arabic font) — no third-party images.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildAss, assColor } from '../src/media/ass.ts';
import { ffmpeg, filterPath } from '../src/media/ffmpeg.ts';

const OUT = resolve(import.meta.dirname, '../branding');
const NAVY = '#0B1E3F', NAVY2 = '#16325F', GOLD = '#F5B700', WHITE = '#FFFFFF', RED = '#E53935';
export const BRAND = { name: 'سر البراند', tagline: 'الحكاية اللي ورا كل ماركة بتعرفها', schedule: 'Shorts كل يوم · حلقة كاملة كل أحد وأربعاء' };

/** Thick polyline → list of separate shapes (one quad per segment + round joints). */
function thickLine(points: [number, number][], w: number): string[] {
  const parts: string[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [x1, y1] = points[i]!, [x2, y2] = points[i + 1]!;
    const len = Math.hypot(x2 - x1, y2 - y1);
    const nx = (-(y2 - y1) / len) * (w / 2), ny = ((x2 - x1) / len) * (w / 2);
    const q = [[x1 + nx, y1 + ny], [x2 + nx, y2 + ny], [x2 - nx, y2 - ny], [x1 - nx, y1 - ny]].map(([a, b]) => `${Math.round(a!)} ${Math.round(b!)}`);
    parts.push(`m ${q[0]} l ${q[1]} ${q[2]} ${q[3]}`);
  }
  for (const [x, y] of points) parts.push(circle(x, y, w / 2));
  return parts;
}
/** Circle as 4 cubic béziers. */
function circle(cx: number, cy: number, r: number): string {
  const k = 0.5523 * r, f = (n: number) => Math.round(n);
  return `m ${f(cx)} ${f(cy - r)} b ${f(cx + k)} ${f(cy - r)} ${f(cx + r)} ${f(cy - k)} ${f(cx + r)} ${f(cy)} b ${f(cx + r)} ${f(cy + k)} ${f(cx + k)} ${f(cy + r)} ${f(cx)} ${f(cy + r)} b ${f(cx - k)} ${f(cy + r)} ${f(cx - r)} ${f(cy + k)} ${f(cx - r)} ${f(cy)} b ${f(cx - r)} ${f(cy - k)} ${f(cx - k)} ${f(cy - r)} ${f(cx)} ${f(cy - r)}`;
}
/** Raw drawing event (bypasses text escaping; drawing commands only, no user text). */
const draw = (shape: string, color: string, alpha = 0) => `Dialogue: 0,0:00:00.00,0:00:05.00,D,,0,0,0,,{\\an7\\pos(0,0)\\bord0\\shad0\\1c${assColor(color)}\\1a&H${alpha.toString(16).padStart(2, '0')}&\\p1}${shape}{\\p0}`;

async function render(name: string, w: number, h: number, texts: { text: string; size: number; color: string; y: number; bold?: boolean }[], drawings: string[]) {
  const ass = buildAss({
    width: w, height: h,
    styles: [
      { name: 'D', font: 'Geeza Pro', size: 10, color: WHITE, outline: '#000000', outlineWidth: 0, alignment: 7, marginV: 0 },
      ...texts.map((t, i) => ({ name: `T${i}`, font: 'Geeza Pro', size: t.size, color: t.color, outline: '#000000', outlineWidth: Math.round(t.size / 28), alignment: 8, marginV: t.y, bold: t.bold })),
    ],
    events: texts.map((t, i) => ({ start: 0, end: 5, style: `T${i}`, text: t.text })),
  }).replace(/^Dialogue: 0,/gm, 'Dialogue: 5,').trimEnd() + '\n' + drawings.join('\n') + '\n';
  const assPath = resolve(OUT, `${name}.ass`);
  writeFileSync(assPath, ass);
  await ffmpeg(['-f', 'lavfi', '-i', `gradients=s=${w}x${h}:c0=${NAVY.replace('#', '0x')}:c1=${NAVY2.replace('#', '0x')}:x0=0:y0=0:x1=${w}:y1=${h}:d=1`, '-vf', `subtitles=filename='${filterPath(assPath)}'`, '-frames:v', '1', '-update', '1', resolve(OUT, `${name}.png`)]);
}

/** Keyhole mark: "the secret behind the brand". */
function keyhole(cx: number, cy: number, s: number, color: string): string[] {
  const r = 0.42 * s;
  const top = cy - 0.25 * s;
  const f = (n: number) => Math.round(n);
  const body = `m ${f(cx - 0.16 * s)} ${f(top + 0.2 * s)} l ${f(cx + 0.16 * s)} ${f(top + 0.2 * s)} ${f(cx + 0.3 * s)} ${f(cy + 0.75 * s)} ${f(cx - 0.3 * s)} ${f(cy + 0.75 * s)}`;
  return [draw(circle(cx, top, r), color), draw(body, color)];
}

/** The old chart mark (kept for reference). */
function logo(cx: number, cy: number, s: number): string[] {
  const p = (x: number, y: number): [number, number] => [cx + x * s, cy + y * s];
  const pts: [number, number][] = [p(-1.0, 0.55), p(-0.55, 0.1), p(-0.2, 0.3), p(0.25, -0.55), p(0.6, 0.05), p(0.95, 0.5)];
  return [
    ...thickLine(pts.slice(0, 4), 0.13 * s).map((sh) => draw(sh, WHITE)),
    ...thickLine(pts.slice(3), 0.13 * s).map((sh) => draw(sh, RED)),
    draw(circle(pts[3]![0], pts[3]![1], 0.17 * s), GOLD),
  ];
}

mkdirSync(OUT, { recursive: true });
// Profile picture: shown as a circle (98 px) — keep it bold and centred.
await render('profile', 800, 800, [{ text: 'سر البراند', size: 118, color: WHITE, y: 555, bold: true }], [draw(circle(400, 400, 392), GOLD), draw(circle(400, 400, 372), NAVY), ...keyhole(400, 300, 230, GOLD)]);
// Watermark (shown bottom-right on videos).
await render('watermark', 150, 150, [], [draw(circle(75, 75, 70), GOLD), draw(circle(75, 75, 62), NAVY), ...keyhole(75, 68, 70, GOLD)]);
// Banner: 2048x1152; everything important inside the 1235x338 safe area (centre).
await render('banner', 2048, 1152, [
  { text: BRAND.name, size: 150, color: WHITE, y: 420, bold: true },
  { text: BRAND.tagline, size: 56, color: GOLD, y: 600 },
  { text: BRAND.schedule, size: 40, color: WHITE, y: 680 },
], [...keyhole(560, 560, 120, GOLD), ...keyhole(1488, 560, 120, GOLD)]);
console.log('branding written to', OUT);
