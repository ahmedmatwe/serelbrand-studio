/**
 * Motion-graphics Shorts. A planner (LLM) picks one drawn scene per idea of the narration (hook → steps on a
 * drawn phone → result → warning → works-on → call to action); code then times every animation to the
 * measured words: each key of a code is pressed when it is said, each settings item is tapped when it is said.
 * The team improves the look over time:
 *  - the editing critic's notes on recent motion Shorts are given to the planner ("fix these"), and a Short
 *    the critic scores low is re-planned once with its own notes before publishing;
 *  - the analyst tunes the style (camera, transitions, captions, flashes) in small steps from the numbers,
 *    and how many Shorts use motion vs stock footage (motionShare).
 * Drawn by motion/MotionShort.tsx (Remotion).
 */
import { execFile } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { AgentContext } from '../agents/base.ts';
import type { PhoneSecret } from '../agents/niche/phone-library.ts';
import { normWord, scriptWords, similarity, type WordTime } from './align.ts';
import { splitSentences } from './shots.ts';
import { readKnowledge } from '../analytics/learner.ts';
import type { IconName, MotionPlan, MotionScene, MotionStyle } from '../../motion/types.ts';

export type { MotionPlan, MotionStyle };

export const DEFAULT_STYLE: MotionStyle = {
  camera: 0.6, transition: 'whip', particles: true, captionSize: 64, flash: 0.22,
  accent: '#FFD23F', good: '#22C55E', bad: '#FF4D4D', bg1: '#070B1A', bg2: '#12204A',
};
const ICONS = ['call', 'shield', 'headset', 'warn', 'check', 'lock', 'antenna', 'chat', 'eye', 'bolt', 'image', 'battery', 'bell', 'mic', 'location', 'trash', 'star', 'search', 'phone', 'camera', 'tune'] as const;

/** The current look: defaults + what the team learned (knowledge `motion_style=`). */
export function motionStyle(ctx: AgentContext): MotionStyle {
  try { return { ...DEFAULT_STYLE, ...(JSON.parse(readKnowledge(ctx, 'motion_style=') ?? '{}') as Partial<MotionStyle>) }; } catch { return DEFAULT_STYLE; }
}
/** Share of Shorts drawn as motion graphics (the rest use stock footage), tuned by the analyst. Default 0.5. */
export function motionShare(ctx: AgentContext): number {
  const v = Number(readKnowledge(ctx, 'motion_share='));
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.5;
}
/**
 * Applies the analyst's wished style in small steps (camera ±0.15, captions ±4 px, flash ±0.06) so one bad week
 * can't swing the look; returns the new style or undefined when nothing changed.
 */
export function stepStyle(cur: MotionStyle, want: Partial<Pick<MotionStyle, 'camera' | 'transition' | 'particles' | 'captionSize' | 'flash'>>): MotionStyle | undefined {
  const step = (a: number, b: number | undefined, max: number, lo: number, hi: number) => (b === undefined ? a : Math.min(hi, Math.max(lo, a + Math.sign(b - a) * Math.min(max, Math.abs(b - a)))));
  const next: MotionStyle = {
    ...cur,
    camera: Number(step(cur.camera, want.camera, 0.15, 0, 1).toFixed(2)),
    captionSize: Math.round(step(cur.captionSize, want.captionSize, 4, 52, 80)),
    flash: Number(step(cur.flash, want.flash, 0.06, 0, 0.4).toFixed(2)),
    transition: want.transition ?? cur.transition,
    particles: want.particles ?? cur.particles,
  };
  return JSON.stringify(next) === JSON.stringify(cur) ? undefined : next;
}

// ── timing helpers (pure) ────────────────────────────────────────────────────────────────────────────────
const SPOKEN: Record<string, string> = {
  صفر: '0', واحد: '1', اتنين: '2', اثنين: '2', تلاته: '3', ثلاثه: '3', اربعه: '4', خمسه: '5', سته: '6', سبعه: '7', تمانيه: '8', ثمانيه: '8', تسعه: '9',
  نجمه: '*', استريسك: '*', شباك: '#', مربع: '#', هاش: '#', شارب: '#',
};
/** When each key of `code` is said: literal code tokens or spoken symbols/digits, in order. Spread if not found. */
export function codeKeyTimes(words: WordTime[], code: string, a: number, b: number): { k: string; at: number }[] {
  const keys = [...code];
  const out: { k: string; at: number }[] = [];
  let p = 0;
  for (const w of words) {
    if (p >= keys.length) break;
    const lit = [...w.w].filter((c) => /[0-9*#]/.test(c));
    const n0 = normWord(w.w), n = SPOKEN[n0] ? n0 : n0.replace(/^(و|ف)/, ''); // "واحد" is a digit, "ونجمة" = "و" + نجمة
    const toks = lit.length ? lit : SPOKEN[n] ? [SPOKEN[n]!] : [];
    toks.forEach((c, j) => {
      if (p < keys.length && c === keys[p]) { out.push({ k: c, at: Number((w.start + (j * Math.max(0.2, w.end - w.start)) / Math.max(1, toks.length)).toFixed(2)) }); p++; }
    });
  }
  if (p === keys.length) return out;
  const span = Math.max(0.3 * keys.length, (b - a) * 0.6), s0 = a + (b - a - span) / 2;
  return keys.map((k, i) => ({ k, at: Number((s0 + (i * span) / keys.length).toFixed(2)) }));
}
/** When each item of a settings path is said (best fuzzy match, in order). Spread if not found. */
export function pathTimes(words: WordTime[], path: string[], a: number, b: number): number[] {
  const out: number[] = [];
  let from = 0;
  for (const item of path) {
    const first = normWord(item.split(/\s+/)[0] ?? item);
    let best = -1, score = 0;
    for (let i = from; i < words.length; i++) { const sc = similarity(normWord(words[i]!.w), first); if (sc > score) { score = sc; best = i; } if (sc === 1) break; }
    if (best < 0 || score < 0.6) break;
    out.push(Number(words[best]!.start.toFixed(2)));
    from = best + 1;
  }
  if (out.length === path.length) return out;
  return path.map((_, i) => Number((a + 0.3 + (i * (b - a - 0.6)) / Math.max(1, path.length)).toFixed(2)));
}
/** Caption chunks (≤ 4 words, broken at pauses and sentence ends) from the measured words. */
export function captionsFromWords(words: WordTime[], duration: number): { a: number; b: number; text: string }[] {
  const out: { a: number; b: number; text: string; w: string[] }[] = [];
  for (const [i, w] of words.entries()) {
    const prev = words[i - 1];
    const cur = out.at(-1);
    const brk = !cur || cur.w.length >= 4 || (prev && (w.start - prev.end > 0.5 || /[.!؟?،,…]$/.test(prev.w)));
    if (brk) out.push({ a: w.start, b: w.end, text: '', w: [w.w] });
    else { cur!.w.push(w.w); cur!.b = w.end; }
  }
  return out.map((c, i) => ({ a: Number(c.a.toFixed(2)), b: Number(Math.min(duration, out[i + 1]?.a ?? duration, c.b + 1).toFixed(2)), text: c.w.join(' ').replace(/[.!؟?،,…]+$/, '') }));
}

// ── planner ──────────────────────────────────────────────────────────────────────────────────────────────
const Hl = z.object({ text: z.string().min(2).max(60), accent: z.string().max(30).optional(), tone: z.enum(['yellow', 'green', 'red']).optional() });
const Planned = z.object({
  scenes: z.array(z.object({
    type: z.enum(['hook', 'dialer', 'settings', 'card', 'alert', 'compat', 'cta', 'statement']),
    from: z.number().int().min(0), to: z.number().int().min(0),
    headline: Hl,
    icon: z.enum(ICONS).optional(),
    question: Hl.optional(), questionSentence: z.number().int().optional(),
    title: z.string().max(40).optional(),
    rows: z.array(z.object({ label: z.string().max(24), value: z.string().max(24), tone: z.enum(['good', 'bad', 'neutral']), then: z.object({ value: z.string().max(24), tone: z.enum(['good', 'bad', 'neutral']), detail: z.string().max(24).optional(), sentence: z.number().int() }).optional() })).max(4).optional(),
    alert: z.object({ text: z.string().max(36), sentence: z.number().int() }).optional(),
    tone: z.enum(['good', 'bad']).optional(),
    action: z.object({ text: z.string().max(40), accent: z.string().max(20).optional(), icon: z.enum(ICONS).default('check'), sentence: z.number().int().optional() }).optional(),
    items: z.array(z.string().max(16)).max(3).optional(),
    badge: z.string().max(30).optional(),
    sub: Hl.optional(),
    lines: z.array(z.string().max(30)).max(3).optional(),
  })).min(2).max(8),
});
type PlannedScene = z.infer<typeof Planned>['scenes'][number];

export interface MotionInput { narration: string; words: WordTime[]; duration: number; title: string; entry?: PhoneSecret; brand: string; endCard: string }

/** Recent editing-critic notes on motion Shorts + the analyst's motion lessons: what to do better this time. */
export function motionLessons(ctx: AgentContext): { criticNotes: string[]; rules: string[] } {
  const criticNotes = ctx.repos.artifacts.listKind<{ look?: string; notes?: string; hook?: number; visualMatch?: number; pacing?: number }>('edit_review')
    .filter((a) => a.data.look === 'motion' && a.data.notes).slice(-6).map((a) => `[hook ${a.data.hook}/10, match ${a.data.visualMatch}/10, pacing ${a.data.pacing}/10] ${a.data.notes}`);
  const rules = ctx.repos.knowledge.byCategory('lesson').map((k) => k.insight).filter((x) => /^Performance \((motion|editing|visuals)/.test(x)).slice(0, 6);
  return { criticNotes, rules };
}

/** Plans + times a motion Short. Never throws: falls back to a simple plan built from the library entry. */
export async function planMotion(ctx: AgentContext, inp: MotionInput, videoId?: string, criticOnThis?: string): Promise<MotionPlan> {
  const sentences = splitSentences(inp.narration);
  // measured start of each sentence
  let wi = 0;
  const starts = sentences.map((s) => { const at = inp.words[Math.min(wi, inp.words.length - 1)]?.start ?? 0; wi += scriptWords(s).length; return at; });
  if (starts.length) starts[0] = 0;
  const sAt = (i: number) => starts[Math.max(0, Math.min(starts.length - 1, i))] ?? 0;
  const ui = inp.entry?.ui;
  const lessons = motionLessons(ctx);
  let planned: PlannedScene[] | undefined;
  if (!ctx.providers.llm.name.startsWith('mock')) {
    const r = await ctx.providers.llm.generateJson({
      task: 'motion.plan',
      tier: 'writing',
      system: 'You are the motion-graphics director of "سر الموبايل" (Egyptian Arabic phone-secret Shorts). Plan drawn scenes for ONE Short so every second shows exactly what is being said. ' +
        'Scene types: hook (first, sentence 0: a big icon + a short shocking headline, optional question at a later sentence), dialer (only if ui.type is dialer: covers the sentences where the code is typed and called), ' +
        'settings (only if ui.type is settings: covers the sentences that walk the path), card (a result/message screen: title + up to 4 rows label/value; a row may change at a later sentence with "then" — e.g. "not forwarded" → "forwarded" + a masked detail), ' +
        'alert (warning or reassurance with an action card, e.g. "call customer service"), compat (which phones it works on: items like "آيفون","أندرويد" + an optional badge), statement (generic: icon + up to 3 short check lines), cta (last: try it now + follow). ' +
        'from/to = inclusive sentence indexes; scenes must cover every sentence in order with no gaps or overlaps; 4–7 scenes. Headlines: ≤ 6 words, natural Egyptian Arabic, readable in 1 second, accent = one word of the headline to colour. ' +
        'Use ONLY what the narration and the library entry say (no invented numbers, apps or results); a code must be written exactly as entry.ui.code. ' +
        'Never widen a claim: keep every condition the narration states (e.g. "iPhone and Android on GSM networks" must NOT become "all phones"; a version, network or setting stays). ' +
        'Make the opening stop the scroll. Apply criticNotes (what the editing critic disliked in recent videos) and rules (learned from view counts) so this video is better than the last. JSON only.',
      prompt: JSON.stringify({ title: inp.title, sentences: sentences.map((s, i) => ({ i, text: s })), entry: inp.entry ? { ui: inp.entry.ui, steps: inp.entry.steps, result: inp.entry.result, use: inp.entry.use, platforms: inp.entry.platforms } : undefined, criticNotes: lessons.criticNotes, rules: lessons.rules, ...(criticOnThis ? { criticOnThisVideo: criticOnThis } : {}) }),
      schema: Planned,
      videoId,
      maxOutputTokens: 2500,
    }).catch(() => undefined);
    planned = (r?.data as z.infer<typeof Planned> | undefined)?.scenes;
  }
  const valid = planned && planned.length >= 2 && planned[0]!.from === 0 && planned.every((p, i) => p.to >= p.from && (i === 0 || p.from === planned![i - 1]!.to + 1)) && planned.at(-1)!.to === sentences.length - 1
    && planned.every((p) => (p.type !== 'dialer' || ui?.type === 'dialer') && (p.type !== 'settings' || ui?.type === 'settings'));
  const plan = valid ? planned! : fallbackPlan(sentences.length, inp.entry);
  const scenes: MotionScene[] = [];
  const beats: number[] = [];
  for (const [k, p] of plan.entries()) {
    const start = k === 0 ? 0 : sAt(p.from);
    const end = k === plan.length - 1 ? inp.duration : sAt(plan[k + 1]!.from);
    if (end - start < 0.6) continue;
    const ws = inp.words.filter((w) => w.start >= start - 0.05 && w.start < end);
    const headline = { ...p.headline, ...(p.headline.accent && !p.headline.text.includes(p.headline.accent) ? { accent: undefined } : {}) };
    const base = { start: Number(start.toFixed(2)), end: Number(end.toFixed(2)), headline };
    const at = (i: number | undefined, frac: number) => (i !== undefined && i >= p.from && i <= p.to ? sAt(i) : start + (end - start) * frac);
    switch (p.type) {
      case 'hook': {
        const qAt = p.question ? at(p.questionSentence ?? p.from + 1, 0.5) : undefined;
        const codeAt = ui?.type === 'dialer' ? inp.words.find((w) => /[0-9*#]/.test(w.w) || SPOKEN[normWord(w.w)] === ui.code[0])?.start : undefined;
        scenes.push({ ...base, type: 'hook', icon: p.icon ?? (ui?.type === 'dialer' ? 'lock' : 'star'), ...(ui?.type === 'dialer' ? { teaserCode: ui.code, revealAt: codeAt ?? end } : {}), ...(p.question ? { question: p.question, questionAt: qAt } : {}) });
        if (qAt) beats.push(qAt);
        break;
      }
      case 'dialer': {
        if (ui?.type !== 'dialer') break;
        const keys = codeKeyTimes(ws, ui.code, start, end);
        const lastKey = keys.at(-1)?.at ?? start;
        const callW = ui.call ? ws.find((w) => w.start > lastKey && /اتصال|كول|call|اتصل/.test(normWord(w.w))) : undefined;
        const callAt = ui.call ? Math.min(end - 0.3, callW?.start ?? lastKey + 0.8) : undefined;
        scenes.push({ ...base, type: 'dialer', code: ui.code, keys, ...(callAt ? { callAt } : {}) });
        if (callAt) beats.push(callAt);
        break;
      }
      case 'settings': {
        if (ui?.type !== 'settings') break;
        scenes.push({ ...base, type: 'settings', os: ui.os, path: ui.path, at: pathTimes(ws, ui.path, start, end) });
        break;
      }
      case 'card': {
        const rows = (p.rows ?? []).map((r, i) => ({ label: r.label, value: r.value, tone: r.tone, at: Number((start + 0.6 + i * 0.4).toFixed(2)), ...(r.then ? { then: { value: r.then.value, tone: r.then.tone, detail: r.then.detail, at: Number(at(r.then.sentence, 0.6).toFixed(2)) } } : {}) }));
        rows.filter((r) => r.then).forEach((r) => beats.push(r.then!.at));
        scenes.push({ ...base, type: 'card', icon: p.icon, title: p.title ?? p.headline.text, rows, ...(p.alert ? { alert: { text: p.alert.text, at: Number(at(p.alert.sentence, 0.6).toFixed(2)) } } : {}) });
        break;
      }
      case 'alert': {
        scenes.push({ ...base, type: 'alert', icon: p.icon ?? (p.tone === 'good' ? 'shield' : 'warn'), tone: p.tone ?? 'bad', ...(p.action ? { action: { text: p.action.text, accent: p.action.accent, icon: p.action.icon, at: Number(at(p.action.sentence, 0.45).toFixed(2)) } } : {}) });
        beats.push(start + 0.1);
        break;
      }
      case 'compat':
        scenes.push({ ...base, type: 'compat', items: p.items?.length ? p.items : ['آيفون', 'أندرويد'], ...(ui?.type === 'dialer' ? { code: ui.code } : {}), ...(p.badge ? { badge: p.badge, badgeAt: Number((start + (end - start) * 0.6).toFixed(2)) } : {}) });
        break;
      case 'cta':
        scenes.push({ ...base, type: 'cta', ...(ui?.type === 'dialer' ? { code: ui.code } : { icon: p.icon ?? 'star' }), ...(p.sub ? { sub: p.sub, subAt: Number((start + 1.2).toFixed(2)) } : {}), followAt: Number(Math.max(start + 1.5, end - 1.6).toFixed(2)) });
        beats.push(start + 0.05);
        break;
      default: {
        const lines = (p.lines ?? []).slice(0, 3);
        scenes.push({ ...base, type: 'statement', icon: p.icon ?? 'star', lines: lines.map((text, i) => ({ text, at: Number((start + 0.5 + (i * (end - start - 0.8)) / Math.max(1, lines.length)).toFixed(2)) })) });
      }
    }
  }
  // a scene dropped above (wrong ui type…) → stretch its neighbour so the timeline has no holes
  for (let i = 1; i < scenes.length; i++) scenes[i - 1]!.end = scenes[i]!.start;
  if (scenes.length) { scenes[0]!.start = 0; scenes.at(-1)!.end = inp.duration; }
  return {
    duration: Number(inp.duration.toFixed(2)), audio: 'narration.m4a', style: motionStyle(ctx), brand: inp.brand, endCard: inp.endCard,
    captions: captionsFromWords(inp.words, inp.duration), beats: [...new Set(beats.map((b) => Number(b.toFixed(2))))].sort((a, b) => a - b), scenes,
  };
}

/** Simple, always-valid plan: hook → the steps on the phone → the rest as statements → cta. */
export function fallbackPlan(n: number, entry?: PhoneSecret): PlannedScene[] {
  const title = entry?.title ?? 'سر في موبايلك';
  const short = title.split(/\s+/).slice(0, 5).join(' ');
  if (n <= 2) return [{ type: 'hook', from: 0, to: 0, headline: { text: short }, icon: 'lock' }, { type: 'cta', from: Math.min(1, n - 1), to: n - 1, headline: { text: 'جرّبها دلوقتي', accent: 'دلوقتي' } }].slice(0, n === 1 ? 1 : 2) as PlannedScene[];
  const ui = entry?.ui;
  const mid: PlannedScene[] = [];
  const stepsAt = Math.min(1, n - 2);
  if (ui) mid.push({ type: ui.type, from: stepsAt, to: Math.min(n - 2, stepsAt + 1), headline: { text: ui.type === 'dialer' ? 'افتح الاتصال واكتب' : 'ادخل على الإعدادات', accent: ui.type === 'dialer' ? 'الاتصال' : 'الإعدادات', tone: 'green' } });
  const next = mid.length ? mid[0]!.to + 1 : 1;
  if (next <= n - 2) mid.push({ type: 'statement', from: next, to: n - 2, headline: { text: 'خلّي بالك', accent: 'بالك' }, icon: 'check' });
  return [{ type: 'hook', from: 0, to: stepsAt - 1 < 0 ? 0 : stepsAt - 1, headline: { text: short }, icon: ui?.type === 'dialer' ? 'lock' : 'star' }, ...mid, { type: 'cta', from: n - 1, to: n - 1, headline: { text: 'جرّبها دلوقتي', accent: 'دلوقتي' } }];
}

// ── render ───────────────────────────────────────────────────────────────────────────────────────────────
export const motionAvailable = (rootDir: string) => existsSync(resolve(rootDir, 'node_modules/.bin/remotion')) && existsSync(resolve(rootDir, 'motion/index.ts'));

/** Draws the plan with Remotion into `out` (1080×1920 H.264 + the narration). */
export async function renderMotion(rootDir: string, plan: MotionPlan, audio: string, out: string): Promise<void> {
  const pub = resolve(dirname(out), `motion-public-${Date.now()}`);
  mkdirSync(pub, { recursive: true });
  try {
    cpSync(resolve(rootDir, 'motion/public/sfx'), resolve(pub, 'sfx'), { recursive: true });
    copyFileSync(audio, resolve(pub, plan.audio));
    const props = resolve(pub, 'props.json');
    writeFileSync(props, JSON.stringify(plan));
    await promisify(execFile)(resolve(rootDir, 'node_modules/.bin/remotion'), ['render', 'motion/index.ts', 'MotionShort', out, `--props=${props}`, `--public-dir=${pub}`, '--codec=h264', '--crf=20', '--log=error'], { cwd: rootDir, timeout: 20 * 60_000, maxBuffer: 32 * 1024 * 1024 });
  } finally { rmSync(pub, { recursive: true, force: true }); }
}

export type { IconName };
