/**
 * Draws a phone screen (ASS vector drawings, rendered by libass) that shows EXACTLY what the narrator says,
 * at the moment it is said: a dialer where the code is typed key by key, or a settings screen where each
 * step of the path lights up, gets tapped and opens the next page. Only the path/code from the approved
 * library is shown; other rows are neutral placeholder bars (nothing invented).
 */
import type { PhoneUi } from '../agents/niche/phone-library.ts';
import { assText, type AssEvent } from './ass.ts';
import { normWord, similarity, type WordTime } from './align.ts';

const col = (hex: string) => { const h = hex.replace('#', ''); return `&H${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`.toUpperCase(); };

/** Rounded rectangle as an ASS drawing path. */
function rrect(x: number, y: number, w: number, h: number, r: number): string {
  const R = Math.min(r, w / 2, h / 2);
  const f = (n: number) => Math.round(n);
  return `m ${f(x + R)} ${f(y)} l ${f(x + w - R)} ${f(y)} b ${f(x + w)} ${f(y)} ${f(x + w)} ${f(y)} ${f(x + w)} ${f(y + R)} ` +
    `l ${f(x + w)} ${f(y + h - R)} b ${f(x + w)} ${f(y + h)} ${f(x + w)} ${f(y + h)} ${f(x + w - R)} ${f(y + h)} ` +
    `l ${f(x + R)} ${f(y + h)} b ${f(x)} ${f(y + h)} ${f(x)} ${f(y + h)} ${f(x)} ${f(y + h - R)} ` +
    `l ${f(x)} ${f(y + R)} b ${f(x)} ${f(y)} ${f(x)} ${f(y)} ${f(x + R)} ${f(y)}`;
}

/** True circle (4 cubic Béziers). */
function circle(cx: number, cy: number, r: number): string {
  const k = 0.5523 * r, f = (n: number) => Math.round(n);
  return `m ${f(cx)} ${f(cy - r)} b ${f(cx + k)} ${f(cy - r)} ${f(cx + r)} ${f(cy - k)} ${f(cx + r)} ${f(cy)} b ${f(cx + r)} ${f(cy + k)} ${f(cx + k)} ${f(cy + r)} ${f(cx)} ${f(cy + r)} ` +
    `b ${f(cx - k)} ${f(cy + r)} ${f(cx - r)} ${f(cy + k)} ${f(cx - r)} ${f(cy)} b ${f(cx - r)} ${f(cy - k)} ${f(cx - k)} ${f(cy - r)} ${f(cx)} ${f(cy - r)}`;
}

interface Ctx { k: number; ev: AssEvent[]; t0: number }
const shape = (c: Ctx, start: number, end: number, layer: number, color: string, path: string, extra = '') =>
  c.ev.push({ start: c.t0 + start, end: c.t0 + end, style: 'UI', layer, raw: true, text: `{\\an7\\pos(0,0)\\bord0\\shad0\\c${col(color)}${extra}\\p1}${path}{\\p0}` });
const label = (c: Ctx, start: number, end: number, layer: number, x: number, y: number, size: number, color: string, text: string, an = 6, bold = false) =>
  c.ev.push({ start: c.t0 + start, end: c.t0 + end, style: 'UI', layer, raw: true, text: `{\\an${an}\\pos(${Math.round(x * c.k)},${Math.round(y * c.k)})\\fs${Math.round(size * c.k)}\\bord0\\shad0\\b${bold ? 1 : 0}\\c${col(color)}}${assText(text)}` });
const R = (c: Ctx, x: number, y: number, w: number, h: number, r: number) => (r * 2 >= Math.min(w, h) && w === h ? circle((x + w / 2) * c.k, (y + h / 2) * c.k, (w / 2) * c.k) : rrect(x * c.k, y * c.k, w * c.k, h * c.k, r * c.k));

// Geometry on a 1080×1920 canvas (scaled by k for other sizes).
const PHONE = { x: 200, y: 430, w: 680, h: 1060, r: 84 };
const SCREEN = { x: 216, y: 446, w: 648, h: 1028, r: 70 };

function frame(c: Ctx, a: number, b: number, screenColor: string) {
  shape(c, a, b, 10, '#000000', R(c, 0, 0, 1080, 1920, 0), '\\1a&H48&\\fad(200,200)'); // dim the footage behind
  shape(c, a, b, 11, '#2C2C2E', R(c, PHONE.x, PHONE.y, PHONE.w, PHONE.h, PHONE.r), '\\fad(200,200)');
  shape(c, a, b, 12, screenColor, R(c, SCREEN.x, SCREEN.y, SCREEN.w, SCREEN.h, SCREEN.r), '\\fad(200,200)');
  shape(c, a, b, 13, '#000000', R(c, 470, SCREEN.y + 14, 140, 34, 17), '\\fad(200,200)'); // camera pill
}

/** Spoken symbols of a code ("نجمة شباك صفر ستة شباك"). */
const SPELL = new Set(['نجمه', 'نجمة', 'شباك', 'هاش', 'صفر', 'واحد', 'اتنين', 'اثنين', 'تلاته', 'ثلاثه', 'اربعه', 'خمسه', 'سته', 'سبعه', 'تمانيه', 'ثمانيه', 'تسعه'].map(normWord));
const isSpell = (w: string) => SPELL.has(normWord(w)) || /^[*#0-9]+$/.test(w.replace(/[.,،؟!:]/g, ''));

/** Times (scene-relative) of the code being spelled out, or undefined. */
export function codeTimes(words: WordTime[], code: string): number[] | undefined {
  let best: [number, number] | undefined;
  for (let i = 0; i < words.length; i++) {
    if (!isSpell(words[i]!.w)) continue;
    let j = i, gap = 0;
    while (j + 1 < words.length && (isSpell(words[j + 1]!.w) || (gap < 1 && words[j + 2] && isSpell(words[j + 2]!.w)))) { if (!isSpell(words[j + 1]!.w)) gap++; j++; }
    if (j - i + 1 >= 3 && (!best || j - i > best[1] - best[0])) best = [i, j];
    i = j;
  }
  if (!best) return undefined;
  const span = words.slice(best[0], best[1] + 1).filter((w) => isSpell(w.w));
  if (span.length === code.length) return span.map((w) => w.start);
  const a = span[0]!.start, b = span.at(-1)!.end;
  return [...code].map((_, n) => a + ((b - a) * n) / code.length);
}

/** Time each path item is mentioned (in order), NaN when not found. */
export function pathTimes(words: WordTime[], path: string[]): number[] {
  let from = 0;
  return path.map((item) => {
    const keys = item.split(/\s+/).map(normWord).filter((w) => w.length >= 3);
    const key = keys.sort((x, y) => y.length - x.length)[0] ?? normWord(item);
    for (let i = from; i < words.length; i++) {
      const w = normWord(words[i]!.w).replace(/^(و|ف)/, '');
      if (similarity(w, key) >= 0.75 || similarity(w.replace(/^ال/, ''), key.replace(/^ال/, '')) >= 0.8) { from = i + 1; return words[i]!.start; }
    }
    return NaN;
  });
}

function dialer(c: Ctx, ui: Extract<PhoneUi, { type: 'dialer' }>, times: number[], a: number, b: number) {
  frame(c, a, b, '#000000');
  label(c, a, b, 14, 300, SCREEN.y + 70, 30, '#FFFFFF', '9:41', 5, true);
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];
  const pos = (key: string) => { const i = keys.indexOf(key); return { x: 540 + ((i % 3) - 1) * 190, y: SCREEN.y + 400 + Math.floor(i / 3) * 145 }; };
  for (const key of keys) {
    const p = pos(key);
    shape(c, a, b, 14, '#333333', R(c, p.x - 62, p.y - 62, 124, 124, 62), '\\fad(200,200)');
    label(c, a, b, 15, p.x, p.y + 4, key === '*' ? 80 : 58, '#FFFFFF', key, 5);
  }
  // Typed code grows key by key exactly when the narrator says each symbol; the pressed key flashes.
  const chars = [...ui.code];
  chars.forEach((ch, n) => {
    const t = times[n]!, next = n + 1 < chars.length ? times[n + 1]! : b;
    label(c, t, next, 15, 540, SCREEN.y + 230, chars.length > 9 ? 62 : 84, '#FFFFFF', chars.slice(0, n + 1).join(''), 5);
    const p = pos(ch);
    if (keys.includes(ch)) shape(c, t, Math.min(t + 0.22, b), 16, '#A5A5A5', R(c, p.x - 62, p.y - 62, 124, 124, 62));
    if (keys.includes(ch)) label(c, t, Math.min(t + 0.22, b), 17, p.x, p.y + 4, ch === '*' ? 80 : 58, '#FFFFFF', ch, 5);
  });
  // Green call key (pulses after the code when the code needs a call).
  const callY = SCREEN.y + 400 + 4 * 145;
  shape(c, a, b, 14, '#34C759', R(c, 540 - 62, callY - 62, 124, 124, 62), '\\fad(200,200)');
  label(c, a, b, 15, 540, callY + 2, 46, '#FFFFFF', '✆', 5);
  if (ui.call) {
    const t = (times.at(-1) ?? a) + 0.5;
    if (t < b) shape(c, t, Math.min(t + 0.5, b), 16, '#FFFFFF', R(c, 540 - 62, callY - 62, 124, 124, 62), '\\1a&H90&\\fad(0,300)');
  }
}

function settings(c: Ctx, ui: Extract<PhoneUi, { type: 'settings' }>, times: number[], a: number, b: number) {
  const ios = ui.os === 'ios';
  const bg = ios ? '#F2F2F7' : '#FFFFFF', card = '#FFFFFF', text = ios ? '#000000' : '#1C1B1F';
  const hl = ios ? '#D1D1D6' : '#E8DEF8', bar = ios ? '#E5E5EA' : '#E6E1E5', accent = ios ? '#34C759' : '#6750A4';
  frame(c, a, b, bg);
  label(c, a, b, 14, 300, SCREEN.y + 70, 30, '#000000', '9:41', 5, true);
  const cardX = SCREEN.x + 28, cardW = SCREEN.w - 56, rowH = 112, top = SCREEN.y + 280;
  // Page j: header = path[j], target row = path[j+1] (tapped when it is said). Last page: path[-1] with a switch.
  const pages = ui.path.length;
  for (let j = 0; j < pages; j++) {
    // Page j+1 opens right after its row was tapped on page j (no overlap between pages).
    const ps = j === 0 ? a : times[j]! + 0.45;
    const pe = j + 1 < pages ? times[j + 1]! + 0.45 : b;
    if (pe <= ps) continue;
    const header = ui.path[j]!;
    label(c, ps, pe, 14, SCREEN.x + SCREEN.w - 44, SCREEN.y + 175, header.length > 14 ? 48 : 62, text, header, 6, true);
    if (ios) shape(c, ps, pe, 13, card, R(c, cardX, top, cardW, rowH * 5, 26));
    const target = j + 1 < pages ? ui.path[j + 1]! : header;
    for (let r = 0; r < 5; r++) {
      const y = top + r * rowH;
      if (r === 2) {
        if (j + 1 < pages) {
          const tap = times[j + 1]!;
          shape(c, Math.max(ps, tap - 0.05), pe, 14, hl, R(c, cardX + 6, y + 6, cardW - 12, rowH - 12, 18));
          shape(c, tap, Math.min(tap + 0.45, pe), 16, '#000000', R(c, cardX + cardW - 230, y + 16, 80, 80, 40), '\\1a&HA0&\\fad(0,250)');
        }
        label(c, ps, pe, 15, cardX + cardW - 36, y + rowH / 2, target.length > 18 ? 34 : 42, text, target, 6, j + 1 >= pages);
        if (j + 1 < pages) label(c, ps, pe, 15, cardX + 40, y + rowH / 2, 46, '#C7C7CC', '‹', 5);
        else {
          // Final setting: the switch turns on a moment after it is named.
          const on = Math.min(b, (times[j] ?? a) + 0.8);
          shape(c, ps, on, 15, '#E9E9EA', R(c, cardX + 34, y + 30, 100, 56, 28));
          shape(c, on, pe, 15, accent, R(c, cardX + 34, y + 30, 100, 56, 28), '\\fad(150,0)');
          shape(c, ps, on, 16, '#FFFFFF', R(c, cardX + 38, y + 34, 48, 48, 24));
          shape(c, on, pe, 16, '#FFFFFF', R(c, cardX + 82, y + 34, 48, 48, 24));
        }
      } else {
        shape(c, ps, pe, 14, bar, R(c, cardX + cardW - 36 - (r % 2 ? 220 : 300), y + rowH / 2 - 12, r % 2 ? 220 : 300, 24, 12));
      }
      if (r < 4 && ios) shape(c, ps, pe, 14, '#E5E5EA', R(c, cardX + 30, y + rowH - 1, cardW - 30, 2, 0));
    }
  }
}

/**
 * Phone-screen events for one scene (scene-relative word times, shifted by `offset`). Undefined when the
 * narration never says the code/path (then the scene keeps its footage).
 */
export function phoneUiEvents(ui: PhoneUi, words: WordTime[], offset: number, duration: number, width: number): AssEvent[] | undefined {
  const c: Ctx = { k: width / 1080, ev: [], t0: offset };
  if (ui.type === 'dialer') {
    const times = codeTimes(words, ui.code);
    if (!times) return undefined;
    const a = Math.max(0, times[0]! - 0.5), b = Math.min(duration - 0.05, times.at(-1)! + (ui.call ? 3.2 : 2.6));
    dialer(c, ui, times, a, b);
  } else {
    let times = pathTimes(words, ui.path);
    const found = times.filter((t) => Number.isFinite(t));
    if (found.length < Math.min(2, ui.path.length)) return undefined;
    // Items not heard: spread between their found neighbours so the screens still advance in order.
    times = times.map((t, i) => {
      if (Number.isFinite(t)) return t;
      const prev = times.slice(0, i).reverse().find((x) => Number.isFinite(x)) ?? found[0]! - 0.8;
      const next = times.slice(i + 1).find((x) => Number.isFinite(x)) ?? prev + 1.6;
      return (prev + next) / 2;
    });
    for (let i = 1; i < times.length; i++) if (times[i]! <= times[i - 1]! + 0.4) times[i] = times[i - 1]! + 0.4;
    const a = Math.max(0, times[0]! - 0.4), b = Math.min(duration - 0.05, times.at(-1)! + 2.6);
    if (b - a < 1.5) return undefined;
    settings(c, ui, times, a, b);
  }
  return c.ev;
}
