/**
 * Builds Advanced SubStation Alpha (ASS) subtitle files.
 * libass shapes Arabic correctly (joined letters, RTL), which FFmpeg's drawtext does not guarantee.
 */
import { countWords } from '../agents/base.ts';
import { shapeArabic } from './arabic-shaper.ts';

export interface AssStyle {
  name: string;
  font: string;
  size: number;
  /** #RRGGBB */
  color: string;
  outline: string;
  outlineWidth: number;
  /** numpad alignment: 2 = bottom-center, 5 = middle-center, 8 = top-center */
  alignment: number;
  marginV: number;
  bold?: boolean;
  boxed?: boolean;
  /** Karaoke "not yet spoken" colour (defaults to `color`). */
  secondary?: string;
  shadow?: number;
}

export interface AssEvent { start: number; end: number; style: string; text: string; fadeMs?: number; /** Word-by-word highlight (\k timing proportional to word length). */ karaoke?: boolean; /** Measured word-by-word highlight: centiseconds per word (from forced alignment). */ karaokeCs?: number[]; /** Short scale-in "pop" when the line appears. */ pop?: boolean; /** Text already contains ASS override/drawing tags (built safely by the caller). */ raw?: boolean; layer?: number }

/** Karaoke text: each word gets {\kN} (centiseconds) so it switches from Secondary to Primary colour when spoken. */
export function karaokeText(text: string, durationSec: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const weight = (w: string) => Math.max(2, [...w].length);
  const total = words.reduce((a, w) => a + weight(w), 0);
  const cs = Math.max(1, Math.round(durationSec * 100));
  let used = 0;
  return words.map((w, i) => {
    const k = i === words.length - 1 ? cs - used : Math.round((cs * weight(w)) / total);
    used += k;
    return `{\\k${Math.max(1, k)}}${assText(w)}`;
  }).join(' ');
}

/** #RRGGBB → ASS &H00BBGGRR */
export function assColor(hex: string, alpha = 0): string {
  const h = hex.replace('#', '').padEnd(6, '0').slice(0, 6);
  const a = alpha.toString(16).padStart(2, '0').toUpperCase();
  return `&H${a}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
}

export function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

/** Neutralises ASS control characters so script text can never inject override tags. */
export function assText(t: string): string {
  // Arabic lines that start with a Latin word ("Shorts كل يوم") must still be laid out right-to-left:
  // a leading RIGHT-TO-LEFT MARK forces the paragraph direction.
  const rtl = /[\u0600-\u06ff]/.test(t) ? '\u200f' : '';
  return (rtl + shapeArabic(t)).replace(/\\/g, '＼').replace(/[{}]/g, (c) => (c === '{' ? '｛' : '｝')).replace(/\r?\n/g, '\\N');
}

export function buildAss(o: { width: number; height: number; styles: AssStyle[]; events: AssEvent[] }): string {
  const style = (s: AssStyle) =>
    `Style: ${s.name},${s.font},${s.size},${assColor(s.color)},${assColor(s.secondary ?? s.color)},${assColor(s.outline)},${assColor('#000000', s.boxed ? 0x60 : 0x80)},${s.bold ? -1 : 0},0,0,0,100,100,0,0,${s.boxed ? 3 : 1},${s.outlineWidth},${s.shadow ?? 0},${s.alignment},60,60,${s.marginV},-1`; // Encoding -1 = libass autodetects base direction (RTL for Arabic)
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${o.width}`,
    `PlayResY: ${o.height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...o.styles.map(style),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...o.events
      .filter((e) => e.end > e.start && e.text.trim())
      .sort((a, b) => (a.layer ?? 0) - (b.layer ?? 0))
      .map((e) => {
        const words = e.text.trim().split(/\s+/);
        const body = e.raw ? e.text : e.karaokeCs && e.karaokeCs.length === words.length
          ? words.map((w, i) => `{\\k${Math.max(1, Math.round(e.karaokeCs![i]!))}}${assText(w)}`).join(' ')
          : e.karaoke ? karaokeText(e.text, e.end - e.start) : assText(e.text);
        const fx = `${e.fadeMs ? `\\fad(${e.fadeMs},${e.fadeMs})` : ''}${e.pop ? '\\fscx86\\fscy86\\t(0,110,\\fscx100\\fscy100)' : ''}`;
        return `Dialogue: ${e.layer ?? 0},${assTime(e.start)},${assTime(e.end)},${e.style},,0,0,0,,${fx ? `{${fx}}` : ''}${body}`;
      }),
    '',
  ].join('\n');
}

/**
 * Splits narration into subtitle chunks (≤ maxWords, preferring sentence/comma boundaries)
 * and spreads them over [start, start+duration] proportionally to word count.
 */
export function chunkSubtitles(text: string, start: number, duration: number, maxWords = 9): { start: number; end: number; text: string }[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length || duration <= 0) return [];
  const chunks: string[][] = [];
  let cur: string[] = [];
  for (const w of words) {
    cur.push(w);
    if (cur.length >= maxWords || (/[.،؟?!:؛]$/.test(w) && cur.length >= 4)) {
      chunks.push(cur);
      cur = [];
    }
  }
  if (cur.length) chunks.push(cur);
  const weight = (c: string[]) => countWords(c.join(' ')) || c.length;
  const total = chunks.reduce((a, c) => a + weight(c), 0);
  let t = start;
  return chunks.map((c) => {
    const d = (duration * weight(c)) / total;
    const e = { start: t, end: Math.min(start + duration, t + d), text: c.join(' ') };
    t += d;
    return e;
  });
}
