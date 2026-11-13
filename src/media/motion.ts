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
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { ffmpegPath as ffmpegBin } from './ffmpeg.ts';
import { basename, dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { AgentContext } from '../agents/base.ts';
import type { PhoneSecret } from '../agents/niche/phone-library.ts';
import { normWord, scriptWords, similarity, type WordTime } from './align.ts';
import { splitSentences } from './shots.ts';
import { readKnowledge } from '../analytics/learner.ts';
import { GENES } from '../../motion/types.ts';
import { readFileSync } from 'node:fs';
import type { Prop, PropAction } from '../../motion/types.ts';
import type { IconName, MotionPlan, MotionScene, MotionStyle, Variants } from '../../motion/types.ts';

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
const DEFAULT_VARIANTS: Variants = { theme: 'studio', bg: 'dots', caption: 'highlight', transition: 'whip', hook: 'rings', headline: 'pop', phone: 'flat' };
/** Critic quality of one review (0–10, opening and match weigh double). */
export const reviewScore = (r: { hook: number; visualMatch: number; pacing: number; captions: number }) => (r.hook * 2 + r.visualMatch * 2 + r.pacing + r.captions) / 6;

/**
 * "The best, but varied." Per design gene:
 *  - a version's score = its critic average (+1 if the analyst chose it from view counts); untried = 6.5;
 *  - only STRONG versions are eligible (score ≥ best − 0.8); a version proven weak (≥ 3 reviews, ≥ 1.5 below the
 *    best) is never used again;
 *  - among the strong ones the pick is varied: never the previous Short's colour theme, and the whole look must
 *    differ from each of the last 3 motion Shorts in ≥ 2 genes.
 * With `explore` one gene may try a version that is still unproven (< 3 reviews), so new versions get measured.
 */
export function chooseVariants(ctx: AgentContext, explore: boolean, rnd: () => number = Math.random): Variants {
  const pref = motionStyle(ctx).variants;
  const reviews = ctx.repos.artifacts.listKind<{ look?: string; variants?: Variants; hook: number; visualMatch: number; pacing: number; captions: number }>('edit_review')
    .filter((a) => a.data.look === 'motion' && a.data.variants).slice(-60).map((a) => a.data);
  const recent = ctx.repos.artifacts.listKind<{ plan?: { style?: { variants?: Variants } } }>('motion_plan')
    .map((a) => a.data.plan?.style?.variants).filter((v): v is Variants => Boolean(v)).slice(-3).reverse();
  const genes = Object.keys(GENES) as (keyof Variants)[];
  const stats = (g: keyof Variants, v: string) => {
    const xs = reviews.filter((r) => r.variants![g] === v).map(reviewScore);
    const mean = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 6.5;
    return { n: xs.length, score: mean + (pref?.[g] === v ? 1 : 0) };
  };
  const pools = {} as Record<keyof Variants, { v: string; w: number }[]>;
  for (const g of genes) {
    const all = GENES[g].map((v) => ({ v, ...stats(g, v) }));
    const best = Math.max(...all.map((x) => x.score));
    // the analyst's pick comes from real view counts: always eligible
    const ok = all.filter((x) => x.score >= best - 0.8 || pref?.[g] === x.v);
    const unproven = all.filter((x) => x.n < 3 && x.score > best - 1.5 && !ok.includes(x));
    pools[g] = (explore ? [...ok, ...unproven] : ok).map((x) => ({ v: x.v, w: Math.max(0.2, x.score - (best - 1)) }));
  }
  const pick = (pool: { v: string; w: number }[]) => { let r = rnd() * pool.reduce((a, x) => a + x.w, 0); for (const x of pool) { r -= x.w; if (r <= 0) return x.v; } return pool.at(-1)!.v; };
  const varied = (c: Variants) => (!recent[0] || c.theme !== recent[0].theme || pools.theme.length < 2) && recent.every((p) => genes.filter((g) => p[g] !== c[g]).length >= 2);
  let out: Variants | undefined;
  for (let k = 0; k < 40 && !out; k++) {
    const c = Object.fromEntries(genes.map((g) => [g, pick(pools[g])])) as Variants;
    if (varied(c) || k === 39) out = c;
  }
  // The colour theme is the channel's identity (owner's choice: the calm "studio" look); the other genes vary.
  // calm like the reference: a dotted or grid background only (no waves / colour blobs)
  const bg = out?.bg === 'grid' ? 'grid' : 'dots';
  return { ...DEFAULT_VARIANTS, ...out, theme: 'studio', bg };
}

/** Share of Shorts drawn as motion graphics (the rest use stock footage), tuned by the analyst. Default 0.5. */
/**
 * The channel moved to professional motion graphics: every Short is drawn (owner's decision, 2026-11-12). Stock
 * footage is only the safety net when drawing fails twice. Learning happens inside motion (design genes, style).
 */
export function motionShare(_ctx: AgentContext): number {
  return 1;
}
/**
 * Applies the analyst's wished style in small steps (camera ±0.15, captions ±4 px, flash ±0.06) so one bad week
 * can't swing the look; returns the new style or undefined when nothing changed.
 */
export function stepStyle(cur: MotionStyle, want: Partial<Pick<MotionStyle, 'camera' | 'transition' | 'particles' | 'captionSize' | 'flash'>> & { variants?: Partial<Variants> }): MotionStyle | undefined {
  const step = (a: number, b: number | undefined, max: number, lo: number, hi: number) => (b === undefined ? a : Math.min(hi, Math.max(lo, a + Math.sign(b - a) * Math.min(max, Math.abs(b - a)))));
  const next: MotionStyle = {
    ...cur,
    camera: Number(step(cur.camera, want.camera, 0.15, 0, 1).toFixed(2)),
    captionSize: Math.round(step(cur.captionSize, want.captionSize, 4, 52, 80)),
    flash: Number(step(cur.flash, want.flash, 0.06, 0, 0.4).toFixed(2)),
    transition: want.transition ?? cur.transition,
    particles: want.particles ?? cur.particles,
    ...(want.variants || cur.variants ? { variants: { ...DEFAULT_VARIANTS, ...(cur.variants ?? {}), ...(want.variants ?? {}) } as Variants } : {}),
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
/** How many items of `path` are actually heard (in order) in `words`. */
export function heardCount(words: WordTime[], path: string[]): number {
  let from = 0, n = 0;
  for (const item of path) {
    const key = normWord([...item.split(/\s+/)].filter((w) => normWord(w).length > 2).sort((x, y) => normWord(y).length - normWord(x).length)[0] ?? item);
    const i = words.findIndex((w, j) => j >= from && similarity(normWord(w.w), key) >= 0.6);
    if (i < 0) break;
    n++; from = i + 1;
  }
  return n;
}

export function pathTimes(words: WordTime[], path: string[], a: number, b: number): number[] {
  const out: number[] = [];
  let from = 0;
  for (const item of path) {
    // the most distinctive word of the step ("ادخل بروفايل الشخص" → "بروفايل"), not a generic verb
    const first = normWord([...item.split(/\s+/)].filter((w) => normWord(w).length > 2).sort((a, b) => normWord(b).length - normWord(a).length)[0] ?? item);
    let best = -1, score = 0;
    for (let i = from; i < words.length; i++) { const sc = similarity(normWord(words[i]!.w), first); if (sc > score) { score = sc; best = i; } if (sc === 1) break; }
    if (best < 0 || score < 0.6) break;
    // step back to where the step starts being said ("آخر ظهور": tap on "آخر", not on "ظهور")
    const parts = item.split(/\s+/).map(normWord);
    while (best > from && parts.some((pw) => similarity(normWord(words[best - 1]!.w), pw) >= 0.8)) best--;
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

// ── props (3D objects of what is said) ────────────────────────────────────────────────────────────────────
const PROPS_FILE = resolve(dirname(new URL(import.meta.url).pathname), '../../config/props.json');
let propCat: { base: string; props: Record<string, string>; animated?: Record<string, string>; animated_base?: string } | undefined;
function catalog() { return (propCat ??= existsSync(PROPS_FILE) ? JSON.parse(readFileSync(PROPS_FILE, 'utf8')) : { base: '', props: {} }); }
export const propNames = () => Object.keys(catalog().props);

/** The catalog name closest to what the director asked for (exact, else the most shared words), or undefined. */
export function resolveProp(thing: string): string | undefined {
  const names = propNames();
  const want = thing.toLowerCase().trim();
  if (catalog().props[want]) return want;
  const tw = new Set(want.split(/[\s-]+/).filter((x) => x.length > 2));
  let best: [string, number] | undefined;
  for (const n of names) {
    const nw = n.split(/[\s-]+/);
    const hit = nw.filter((x) => tw.has(x)).length;
    const sc = hit / Math.max(nw.length, tw.size);
    if (hit && (!best || sc > best[1] || (sc === best[1] && n.length < best[0].length))) best = [n, sc];
  }
  return best && best[1] >= 0.5 ? best[0] : undefined;
}
export const propFile = (name: string) => basename(catalog().props[name] ?? '');
export const propUrl = (name: string) => catalog().base + (catalog().props[name] ?? '').split('/').map(encodeURIComponent).join('/');

/**
 * Word → thing: when one of these words is SAID, its object appears at that moment (if the director did not
 * already put something there) — the viewer sees what they hear, all the time.
 */
const WORD_PROPS: [RegExp, string][] = [
  [/فلوس|اشتراك|بتدفع|ادفع|بفلوس/, 'money with wings'], [/ببلاش|مجان|هدية/, 'wrapped gift'], [/صور|صورة/, 'framed picture'], [/كاميرا|تصوير/, 'camera'],
  [/فيديو|ريلز/, 'film frames'], [/رسال|رسايل|شات|محادث/, 'speech balloon'], [/مكالم|اتصال|كول/, 'telephone receiver'], [/دقيقة|ثواني|ثانية|وقت|ساعة/, 'hourglass not done'],
  [/سري|مخفي|محدش يعرف|سر(?![\u0600-\u06FF])/, 'eyes'], [/سريع|بسرعة|فوراً|في لحظة/, 'high voltage'], [/فكرة|اكتشف/, 'light bulb'], [/خطر|تحذير|احذر|خلي بالك|إوعى/, 'warning'],
  [/جديد|سحري|سحرية/, 'sparkles'], [/ذكاء اصطناعي|جيميناي|روبوت/, 'robot'], [/واي فاي|الإنترنت|النت(?![\u0600-\u06FF])|شبكة/, 'antenna bars'], [/بطاري|شحن/, 'battery'],
  [/موبايل|تليفون|الهاتف/, 'mobile phone'], [/ملف|pdf|ورق|مستند/i, 'page facing up'], [/مذاكرة|كتاب|دراسة/, 'books'], [/صوت|صوتية|تسمع/, 'speaker high volume'],
  [/سؤال|اسأل|اسأله/, 'red question mark'], [/جاوب|إجابة|صح(?![\u0600-\u06FF])/, 'check mark button'], [/احفظ|احفظه|احفظها/, 'bookmark'], 
  [/ناس|الكل|أصحاب|صاحبك/, 'busts in silhouette'], [/أحسن|أقوى|الأفضل/, 'trophy'], [/جامد|نار(?![\u0600-\u06FF])/, 'fire'], [/باسورد|كلمة سر|قفل|اقفل/, 'locked with key'],
  [/إشعار|اشعار|تنبيه/, 'bell'], [/ترجم|لغة/, 'globe showing europe-africa'], [/أمان|حماية|احمي/, 'shield'], [/منبه|الصبح/, 'alarm clock'],
];
const ACTIONS: PropAction[] = ['pop', 'drop', 'fly-in', 'spin', 'pulse'];

/** Adds the said-word objects to each scene (≤ 4 per scene, never within 0.9 s of another object). */
export function wordProps(scenes: MotionScene[], words: WordTime[]): void {
  let k = 0;
  for (const sc of scenes) {
    if (sc.type === 'story' || sc.type === 'hook') continue;
    // under an acted-out screen: the low corners; on the comparison: under the two cards; else beside the content
    const slots = sc.type === 'mock' ? [2, 3] : sc.type === 'versus' ? [4, 5] : [0, 1, 2];
    const props = (sc.props ??= []);
    const used = new Set(props.map((x) => x.src));
    for (const w of words.filter((x) => x.start >= sc.start + 0.2 && x.start < sc.end - 0.5)) {
      if (props.length >= 4) break;
      const name = WORD_PROPS.find(([re]) => re.test(w.w))?.[1];
      if (!name || !catalog().props[name]) continue;
      const src = `props/${propFile(name)}`;
      if (used.has(src) || props.some((p) => Math.abs(p.at - w.start) < 0.9)) continue;
      const busy = new Set(props.filter((p) => p.until > w.start).map((p) => p.slot));
      const slot = slots.find((x) => !busy.has(x));
      if (slot === undefined) continue;
      const cp = catalog().animated?.[name];
      const at = Number(Math.max(sc.start + 0.1, w.start - 0.05).toFixed(2));
      props.push({ src, at, until: Number(Math.min(sc.end, at + 2.2).toFixed(2)), action: ACTIONS[k++ % ACTIONS.length]!, slot, ...(cp ? { lottie: `props/anim-${cp}.json` } : {}) });
      used.add(src);
    }
    props.sort((a, b) => a.at - b.at);
    if (!props.length) delete sc.props;
  }
}

/** The topic's main object from its words (first match wins: the most specific topics first). */
const HERO_WORDS: [RegExp, string][] = [
  [/pdf|ملف|مستند|ورق|سكان|مسح ضوئي/i, 'page facing up'], [/ذكاء اصطناعي|\bai\b|جيميناي|gemini|روبوت/i, 'robot'], [/واتساب|رسايل|رسالة|شات|محادث/i, 'speech balloon'], [/مكالم|اتصال|كول/i, 'telephone receiver'],
  [/صور|صورة|الكاميرا|كاميرا|سيلفي/i, 'camera with flash'], [/فيديو|ريلز|يوتيوب|تيك توك/i, 'clapper board'], [/بطاري|شحن|شاحن/i, 'battery'],
  [/باسورد|كلمة سر|قفل|خصوصي|تقيي?د|بلوك/i, 'locked'], [/واي فاي|الإنترنت|النت\b|شبكة/i, 'antenna bars'], [/ترجم/i, 'globe showing europe-africa'],
  [/صوت|بودكاست|ميكروفون|تسجيل/i, 'studio microphone'], [/لوكيشن|خريطة|مكان/i, 'world map'],
  [/فلوس|اشتراك|ادفع|بفلوس|مجان/i, 'money bag'], [/إشعار|اشعار|تنبيه/i, 'bell'], [/نوم|تنام/i, 'sleeping face'], [/موبايل|تليفون|الهاتف/i, 'mobile phone'],
];
export function heroFromWords(text: string): string | undefined {
  for (const [re, name] of HERO_WORDS) if (re.test(text) && catalog().props[name]) return name;
  return undefined;
}

/** Timed props of one scene: each appears when its word is said (else when its sentence starts). */
function sceneProps(planned: { thing: string; word?: string; sentence: number; action: PropAction }[] | undefined, ws: WordTime[], sAt: (i: number) => number, start: number, end: number, big: boolean, hook = false, under = false): Prop[] {
  // The hook's big headline sits in the middle: its props use the lower slots only; under a screen, the low corners.
  const slots = big ? [10, 11, 12] : under ? [2, 3] : hook ? [1, 2] : [0, 1, 2];
  const out: Prop[] = [];
  for (const x of (planned ?? []).slice(0, slots.length)) {
    const name = resolveProp(x.thing);
    if (!name || out.some((o) => o.src === `props/${propFile(name)}`)) continue;
    const s0 = Math.max(start, Math.min(end - 0.5, sAt(x.sentence)));
    const w = x.word ? ws.find((v) => v.start >= s0 - 0.05 && similarity(normWord(v.w), normWord(x.word!)) >= 0.7) : undefined;
    const at = Number(Math.min(end - 0.4, Math.max(start + 0.15, w ? w.start - 0.1 : s0 + 0.25)).toFixed(2));
    // things come and go (≈ 2.4 s each, the next one takes over) — story objects stay for their scene
    const until = big ? end : Math.min(end, at + 2.4);
    const cp = catalog().animated?.[name];
    out.push({ src: `props/${propFile(name)}`, at, until: Number(until.toFixed(2)), action: x.action, slot: slots[out.length]!, ...(cp ? { lottie: `props/anim-${cp}.json` } : {}) });
  }
  return out;
}

// ── planner ──────────────────────────────────────────────────────────────────────────────────────────────
const Hl = z.object({ text: z.string().min(2).transform((x) => x.slice(0, 60)), accent: z.string().max(30).optional().catch(undefined), tone: z.enum(['yellow', 'green', 'red']).optional().catch(undefined) });
const Planned = z.object({
  hero: z.string().max(40).optional().catch(undefined),
  scenes: z.array(z.object({
    type: z.enum(['hook', 'dialer', 'settings', 'app', 'card', 'alert', 'compat', 'cta', 'statement', 'versus', 'story', 'mock']),
    from: z.number().int().min(0), to: z.number().int().min(0),
    headline: Hl,
    icon: z.enum(ICONS).optional().catch(undefined),
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
    mock: z.object({
      kind: z.enum(['chat', 'bars', 'checklist', 'ranked', 'search', 'link', 'video', 'doc', 'timer', 'notify', 'price']),
      title: z.string().max(40).optional(),
      items: z.array(z.object({ text: z.string().transform((x) => x.slice(0, 44)), sentence: z.number().int(), word: z.string().max(30).optional(), value: z.number().optional(), label: z.string().max(18).optional(), mark: z.enum(['check', 'cross', 'win']).optional().catch(undefined), highlight: z.array(z.string()).optional().catch(undefined) })).min(1).transform((x) => x.slice(0, 6)),
      final: z.object({ text: z.string().max(30), sentence: z.number().int(), tone: z.enum(['good', 'bad']) }).optional().catch(undefined),
    }).optional().catch(undefined),
    props: z.array(z.object({ thing: z.string().max(40), word: z.string().max(30).optional(), sentence: z.number().int(), action: z.enum(['pop', 'fly-in', 'drop', 'fly-away', 'shake', 'spin', 'pulse', 'no']).default('pop').catch('pop') })).optional().catch(undefined),
  })).min(2).max(16),
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
export async function planMotion(ctx: AgentContext, inp: MotionInput, videoId?: string, criticOnThis?: string, explore = Math.random() < 0.3): Promise<MotionPlan> {
  const sentences = splitSentences(inp.narration);
  // measured start of each sentence
  let wi = 0;
  const starts = sentences.map((s) => { const at = inp.words[Math.min(wi, inp.words.length - 1)]?.start ?? 0; wi += scriptWords(s).length; return at; });
  if (starts.length) starts[0] = 0;
  const sAt = (i: number) => starts[Math.max(0, Math.min(starts.length - 1, i))] ?? 0;
  const ui = inp.entry?.ui;
  const lessons = motionLessons(ctx);
  let planned: PlannedScene[] | undefined;
  let heroThing: string | undefined;
  if (!ctx.providers.llm.name.startsWith('mock')) {
    const r = await ctx.providers.llm.generateJson({
      task: 'motion.plan',
      tier: 'writing',
      system: 'You are the motion-graphics director of "سر الموبايل" (Egyptian Arabic phone-secret Shorts). Plan drawn scenes for ONE Short so every second shows exactly what is being said. ' +
        'Scene types: hook (first, sentence 0: a big icon + a short shocking headline, optional question at a later sentence), dialer (only if ui.type is dialer: covers the sentences where the code is typed and called), ' +
        'settings (only if ui.type is settings: covers the sentences that walk the path), app (the steps inside an app — Instagram, WhatsApp, TikTok… — or on the phone when there is no dialer/settings screen: covers the sentences that walk entry.steps), card (a result/message screen: title + up to 4 rows label/value; a row may change at a later sentence with "then" — e.g. "not forwarded" → "forwarded" + a masked detail), ' +
        'versus (only if ui.type is versus: the paid tool vs the free one — covers the sentences that compare them; it MUST appear right after the hook), ' +
        'alert (warning or reassurance with an action card, e.g. "call customer service"), compat (which phones it works on: items like "آيفون","أندرويد" + an optional badge), statement (generic: icon + up to 3 short check lines), cta (last: try it now + follow). ' +
        'SHOW THE CLOSEST THING TO WHAT IS SAID: the steps always get a dialer/settings/app scene; the result gets a card; use "statement" only when nothing else fits (at most once); never two scenes of the same type in a row; "compat" only if the narration names which phones. ' +
        'THE CHANNEL\'S REFERENCE STYLE: the picture changes with EVERY sentence (every 2–3 seconds) — ONE scene per sentence (two sentences only when they are one idea), and each scene shows exactly what ITS sentence says (an acted-out mock screen, the steps on the phone, or a story with objects). Never one scene over many sentences. ' +
        'from/to = inclusive sentence indexes; scenes must cover every sentence in order with no gaps or overlaps. Headlines: 2–4 words (≤ 24 characters, they are drawn on ONE big line), natural Egyptian Arabic, readable in 1 second, accent = one word of the headline to colour. ' +
        'Use ONLY what the narration and the library entry say (no invented numbers, apps or results); a code must be written exactly as entry.ui.code. ' +
        'Never widen a claim: keep every condition the narration states (e.g. "iPhone and Android on GSM networks" must NOT become "all phones"; a version, network or setting stays). ' +
        'mock = ACT THE IDEA OUT with a small realistic screen — THE CHANNEL\'S SIGNATURE STYLE: MOST scenes are mock screens of VARIED kinds (never the same kind twice in a row): the problem, each benefit, the result, the limits…; statement and card only when no mock fits. A mock scene has type "mock" and its content in "mock": ' +
        'chat (messages; value 1 = mine; mark cross/check on a message), bars (a chart: value = height, label like "×5.0", mark win = the winner), checklist (items ticked one by one), ranked (numbered list, mark win = first), ' +
        'search (title = the query being typed, items = results with label as subtitle), link (title = sender; items[0] = url, items[1] = page title — "it sends you the link"), video (REC frame: title = label, items = chips), ' +
        'doc (text lines; highlight = the exact words to mark, mark cross = words removed), timer (items[0].value = seconds, text = what takes that long), notify (stacked notifications; label = app), price (rows: text + label like "مجاناً"/"اشتراك", mark cross/win). ' +
        'Example: {"type":"mock","from":3,"to":4,"headline":{"text":"الحشو بيتشال","accent":"الحشو"},"mock":{"kind":"doc","items":[{"text":"يعني بصراحة الفكرة دي","sentence":3,"highlight":["يعني","بصراحة"],"mark":"cross"},{"text":"والنتيجة جت أسرع","sentence":4}]}}. ' +
        'Fill it with the narration\'s own words (short, ≤ 6 words per item), each item timed by sentence + word; final = an optional result tag under it (e.g. "اتحفظ ✓"). Never invent numbers: bars/ranked values only from the narration or entry, else relative heights with no number labels. ' +
        'BRING IT TO LIFE — never just a screen with information: in EVERY scene add 1–3 props = 3D objects of the concrete things the sentences name or picture (a shoe when a shoe is mentioned, money with wings when money is wasted every month, a robot for AI, a locked padlock for privacy, a camera for photos, a hourglass for waiting…). ' +
        'thing = a name from propNames (exact); word = the Arabic word in that sentence that names or evokes it (it appears exactly when that word is said); sentence = its index; action: pop (appears), fly-in, drop (falls in), fly-away (leaves: money spent, data lost), shake (alarm, danger), spin (magic, transformation), pulse (important), no (crossed out: what you no longer need). ' +
        'story = a scene for a SITUATION the narration describes (paying every month, someone reading your messages, a crowded photo, a long lecture): told with 1–3 big props and their actions instead of a screen — use it for at least one situation sentence when the video has one. ' +
        'hero = THE main object of the whole video from propNames (exact), the thing the topic is about — e.g. "page facing up" for a PDF, "framed picture" for photos, "speech balloon" for WhatsApp messages, "battery" for battery, "locked" for privacy; it is drawn big in the opening and the ending instead of any generic icon. ' +
        'Make the opening stop the scroll. Apply criticNotes (what the editing critic disliked in recent videos) and rules (learned from view counts) so this video is better than the last. JSON only.',
      prompt: JSON.stringify({ propNames: propNames().join('|'), title: inp.title, sentences: sentences.map((s, i) => ({ i, text: s })), entry: inp.entry ? { ui: inp.entry.ui, steps: inp.entry.steps, result: inp.entry.result, use: inp.entry.use, platforms: inp.entry.platforms } : undefined, criticNotes: lessons.criticNotes, rules: lessons.rules, ...(criticOnThis ? { criticOnThisVideo: criticOnThis } : {}) }),
      schema: Planned,
      videoId,
      maxOutputTokens: 20000,
    }).catch(() => undefined);
    planned = (r?.data as z.infer<typeof Planned> | undefined)?.scenes;
    heroThing = (r?.data as z.infer<typeof Planned> | undefined)?.hero;
  }
  // Small sentence-range slips are repaired instead of throwing the director's plan away: an overlap shortens the
  // previous scene, a gap stretches it, a scene swallowed by the previous one is dropped.
  if (planned?.length) {
    const fixed: PlannedScene[] = [];
    for (const p of planned) {
      const prev = fixed.at(-1);
      if (!prev) { fixed.push({ ...p, from: 0 }); continue; }
      if (p.from > prev.to + 1) prev.to = p.from - 1;
      else if (p.from <= prev.to) { if (p.from > prev.from) prev.to = p.from - 1; else if (p.to > prev.to) { fixed.push({ ...p, from: prev.to + 1 }); continue; } else continue; }
      fixed.push({ ...p });
    }
    planned = fixed.filter((p) => p.to >= p.from);
  }
  // A plan that stops before the last sentence is extended to the end (instead of throwing the whole plan away).
  if (planned?.length && planned.at(-1)!.to < sentences.length - 1 && planned.at(-1)!.to >= sentences.length - 4) planned.at(-1)!.to = sentences.length - 1;
  const valid = planned && planned.length >= 2 && planned[0]!.from === 0 && planned.every((p, i) => p.to >= p.from && (i === 0 || p.from === planned![i - 1]!.to + 1)) && planned.at(-1)!.to === sentences.length - 1
    && planned.every((p) => (p.type !== 'dialer' || ui?.type === 'dialer') && (p.type !== 'settings' || ui?.type === 'settings') && (p.type !== 'app' || Boolean(inp.entry?.steps.length)) && (p.type !== 'versus' || ui?.type === 'versus'));
  const plan = normalizePlan(valid ? planned! : fallbackPlan(sentences.length, inp.entry), inp.entry);
  const scenes: MotionScene[] = [];
  const beats: number[] = [];
  for (const [k, p] of plan.entries()) {
    const start = k === 0 ? 0 : sAt(p.from);
    const end = k === plan.length - 1 ? inp.duration : sAt(plan[k + 1]!.from);
    if (end - start < 0.6) continue;
    const ws = inp.words.filter((w) => w.start >= start - 0.05 && w.start < end);
    const headline = { ...p.headline, ...(p.headline.accent && !p.headline.text.includes(p.headline.accent) ? { accent: undefined } : {}) };
    // Props never cover the main thing: beside the content, under an acted-out screen, none on the comparison.
    const props = p.type === 'versus' ? [] : sceneProps(p.props, ws, sAt, start, end, p.type === 'story', p.type === 'hook', p.type === 'mock');
    const base = { start: Number(start.toFixed(2)), end: Number(end.toFixed(2)), headline, ...(props.length ? { props } : {}) };
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
      case 'settings':
      case 'app': {
        // An app's own steps are drawn in that app's colours; phone settings keep the settings look.
        const brand = APP_BRAND[inp.entry?.source ?? ''];
        if (p.type === 'settings' && ui?.type === 'settings' && !brand) { scenes.push({ ...base, type: 'settings', os: ui.os, path: ui.path, at: pathTimes(ws, ui.path, start, end) }); break; }
        // The step list that the narration really walks through (the drawn settings path or the entry's steps).
        const options = [ui?.type === 'settings' ? ui.path : [], inp.entry?.steps ?? []].filter((x) => x.length).map((x) => x.slice(0, 6));
        const steps = options.sort((x, y) => heardCount(ws, y) / y.length - heardCount(ws, x) / x.length)[0] ?? [];
        if (!steps.length) break;
        const [app, color, color2] = brand ?? (ui?.type === 'versus' ? [ui.free.name, ui.free.color ?? '#4285F4', '#23408E'] : ui?.type === 'settings' && ui.os === 'ios' ? ['الإعدادات', '#8E8E93', '#5A5A60'] : ['الإعدادات', '#3DDC84', '#1F9D57']);
        scenes.push({ ...base, type: 'app', app, color, color2, steps, at: pathTimes(ws, steps, start, end), done: inp.entry?.onScreen });
        break;
      }
      case 'card': {
        // rows appear one by one across the scene (each while it is being explained), not all at once
        const nRows = Math.max(1, (p.rows ?? []).length);
        const rows = (p.rows ?? []).map((r, i) => ({ label: r.label, value: r.value, tone: r.tone, at: Number((start + 0.5 + (i * Math.max(0.4, (end - start - 1.5))) / nRows).toFixed(2)), ...(r.then ? { then: { value: r.then.value, tone: r.then.tone, detail: r.then.detail, at: Number(at(r.then.sentence, 0.6).toFixed(2)) } } : {}) }));
        rows.filter((r) => r.then).forEach((r) => beats.push(r.then!.at));
        scenes.push({ ...base, type: 'card', icon: p.icon, title: p.title ?? p.headline.text, rows, ...(p.alert ? { alert: { text: p.alert.text, at: Number(at(p.alert.sentence, 0.6).toFixed(2)) } } : {}) });
        break;
      }
      case 'alert': {
        scenes.push({ ...base, type: 'alert', icon: p.icon ?? (p.tone === 'good' ? 'shield' : 'warn'), tone: p.tone ?? 'bad', ...(p.action ? { action: { text: p.action.text, accent: p.action.accent, icon: p.action.icon, at: Number(at(p.action.sentence, 0.45).toFixed(2)) } } : {}) });
        beats.push(start + 0.1);
        break;
      }
      case 'versus': {
        if (ui?.type !== 'versus') break;
        // The free card arrives when its name is said (else a little before the middle of the scene).
        const keys = [ui.free.name.split(/\s+/)[0] ?? '', ...(ui.free.say ?? [])].map(normWord).filter(Boolean);
        const inScene = ws.filter((x) => x.start >= start + 0.4 && x.start < end);
        const w = inScene.find((x) => keys.some((k) => similarity(normWord(x.w), k) >= 0.7)) ?? inScene.find((x) => /ببلاش|مجان/.test(x.w));
        const freeAt = Number(Math.min(end - 0.6, w?.start ?? start + (end - start) * 0.45).toFixed(2));
        scenes.push({ ...base, type: 'versus', paid: ui.paid, free: { name: ui.free.name, note: ui.free.note }, freeAt });
        beats.push(freeAt);
        break;
      }
      case 'mock': {
        if (!p.mock) { scenes.push({ ...base, type: 'statement', icon: p.icon ?? 'star', lines: [] }); break; }
        const tAt = (sentence: number, word: string | undefined, d: number) => {
          const s0 = Math.max(start, Math.min(end - 0.5, sAt(sentence)));
          const w = word ? ws.find((v) => v.start >= s0 - 0.05 && similarity(normWord(v.w), normWord(word)) >= 0.7) : undefined;
          return Number(Math.min(end - 0.35, Math.max(start + 0.3, w ? w.start - 0.05 : s0 + d)).toFixed(2));
        };
        // items in narration order, each a little after the previous so they never pop all at once
        let last = start + 0.2;
        const items = p.mock.items.map((it, i) => { const a = Math.max(last + 0.25, tAt(it.sentence, it.word, 0.2 + i * 0.05)); last = a; return { text: it.text, at: Number(Math.min(end - 0.3, a).toFixed(2)), value: it.value, label: it.label, mark: it.mark, highlight: it.highlight }; });
        // calm like the reference: items animate in without the flash/camera kick of beats
        scenes.push({ ...base, type: 'mock', kind: p.mock.kind, ...(p.mock.title ? { title: p.mock.title } : {}), items, ...(p.mock.final ? { final: { text: p.mock.final.text, tone: p.mock.final.tone, at: tAt(p.mock.final.sentence, undefined, 0.5) } } : {}) });
        break;
      }
      case 'story':
        // No drawable object found → a plain statement keeps the time covered (never an empty gap).
        if (!props.length) { scenes.push({ ...base, type: 'statement', icon: p.icon ?? 'star', lines: [] }); break; }
        scenes.push({ ...base, type: 'story' });
        props.forEach((x) => beats.push(x.at));
        break;
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
  wordProps(scenes, inp.words);
  // THE main object: the director's pick, else the topic's own words, else the first object it drew.
  const heroName = (heroThing && resolveProp(heroThing)) || heroFromWords(`${inp.title} ${inp.entry?.onScreen ?? ''} ${inp.narration}`);
  const hero = heroName ? `props/${propFile(heroName)}` : scenes.flatMap((x) => x.props ?? [])[0]?.src;
  return {
    duration: Number(inp.duration.toFixed(2)), audio: 'narration.m4a', ...(hero ? { hero } : {}), style: { ...motionStyle(ctx), variants: chooseVariants(ctx, explore || Boolean(criticOnThis)) }, brand: inp.brand, endCard: inp.endCard,
    captions: captionsFromWords(inp.words, inp.duration), beats: [...new Set(beats.map((b) => Number(b.toFixed(2))))].sort((a, b) => a - b), scenes,
  };
}

/** App colours (a coloured header + name, no logos) for drawn app screens. */
const APP_BRAND: Record<string, [string, string, string]> = {
  instagram: ['إنستجرام', '#E1306C', '#F77737'], whatsapp: ['واتساب', '#25D366', '#128C7E'], tiktok: ['تيك توك', '#FE2C55', '#25C4DE'],
  facebook: ['فيسبوك', '#1877F2', '#3B5998'], youtube: ['يوتيوب', '#FF0000', '#B80000'], telegram: ['تليجرام', '#229ED9', '#1B7FB5'],
  google: ['جوجل', '#4285F4', '#34A853'], chrome: ['كروم', '#4285F4', '#EA4335'], maps: ['خرايط جوجل', '#34A853', '#4285F4'],
  gboard: ['كيبورد جوجل', '#4285F4', '#34A853'], x: ['إكس', '#2A2A2A', '#555555'], snapchat: ['سناب شات', '#E6C800', '#B89F00'], samsung: ['سامسونج', '#1428A0', '#0B1F7A'],
};

/**
 * Makes the plan show the closest thing to what is said: the steps always get their screen (dialer / settings /
 * app) — the first generic scene after the hook becomes it if the director forgot — and two scenes of the same
 * type in a row are merged (no repeated visuals).
 */
export function normalizePlan(plan: PlannedScene[], entry?: PhoneSecret): PlannedScene[] {
  const out = plan.map((p) => ({ ...p }));
  const stepsType = entry?.ui?.type === 'dialer' ? 'dialer' : entry?.ui?.type === 'settings' && !APP_BRAND[entry.source] ? 'settings' : entry?.steps.length ? 'app' : undefined;
  // (an acted-out screen may already show the app steps — then no extra steps screen is forced in)
  if (stepsType && !out.some((p) => p.type === 'dialer' || p.type === 'settings' || p.type === 'app' || (stepsType === 'app' && p.type === 'mock'))) {
    const i = out.findIndex((p, j) => j > 0 && j < out.length - 1 && (p.type === 'statement' || p.type === 'card' || p.type === 'compat'));
    if (i > 0) out[i]!.type = stepsType;
  }
  if (entry && APP_BRAND[entry.source]) for (const p of out) if (p.type === 'settings') p.type = 'app';
  // A plain statement (icon + sentence) is the weakest picture: with objects it becomes a story (the objects big),
  // with lines an acted-out checklist.
  // (an acted-out screen the director left empty is treated the same way)
  for (const p of out.filter((x) => x.type === 'statement' || (x.type === 'mock' && !x.mock))) {
    if (p.props?.length) p.type = 'story';
    else if (p.type === 'mock') p.type = 'statement';
    else if (p.lines?.length) { p.mock = { kind: 'checklist', items: p.lines.slice(0, 4).map((text, i) => ({ text, sentence: Math.min(p.to, p.from + i) })) }; p.type = 'mock'; }
  }
  // The signature look: if the director drew no acted-out screen, its cards / statements become checklists
  // (each row or line ticked when its sentence is said) — never a video of plain info screens only.
  if (!out.some((p) => p.type === 'mock')) {
    for (const p of out.filter((x) => x.type === 'card' || x.type === 'statement')) {
      const rows = (p.rows ?? []).map((r) => `${r.label}: ${r.value}`.slice(0, 44)).concat(p.lines ?? []).slice(0, 4);
      const texts = rows.length ? rows : [p.headline.text];
      p.mock = { kind: 'checklist', items: texts.map((text, i) => ({ text, sentence: Math.min(p.to, p.from + Math.floor((i * (p.to - p.from + 1)) / texts.length)) })) };
      p.type = 'mock';
    }
  }
  // "Why pay?" topics: the paid-vs-free comparison is the point of the video — it must be on screen.
  if (entry?.ui?.type === 'versus' && !out.some((p) => p.type === 'versus')) {
    const i = out.findIndex((p, j) => j > 0 && j < out.length - 1 && (p.type === 'statement' || p.type === 'compat' || p.type === 'alert' || p.type === 'card'));
    if (i > 0) out[i]!.type = 'versus';
  }
  const merged: PlannedScene[] = [];
  for (const p of out) {
    const prev = merged.at(-1);
    // acted-out screens / stories carry their own content: two in a row are two different screens, never merged
    if (prev && prev.type === p.type && !['hook', 'cta', 'mock', 'story'].includes(p.type)) { prev.to = p.to; continue; }
    merged.push(p);
  }
  return merged;
}

/** Simple, always-valid plan: hook → the steps on the phone → the rest as statements → cta. */
export function fallbackPlan(n: number, entry?: PhoneSecret): PlannedScene[] {
  const title = entry?.title ?? 'سر في موبايلك';
  const short = title.split(/\s+/).slice(0, 5).join(' ');
  if (n <= 2) return [{ type: 'hook', from: 0, to: 0, headline: { text: short }, icon: 'lock' }, { type: 'cta', from: Math.min(1, n - 1), to: n - 1, headline: { text: 'جرّبها دلوقتي', accent: 'دلوقتي' } }].slice(0, n === 1 ? 1 : 2) as PlannedScene[];
  const ui = entry?.ui;
  const mid: PlannedScene[] = [];
  // "Why pay?": the comparison comes right after the hook, then the steps of the free tool.
  const vs = ui?.type === 'versus' && n >= 4;
  if (vs) mid.push({ type: 'versus', from: 1, to: 1, headline: { text: 'ليه تدفع؟', accent: 'تدفع', tone: 'red' } });
  const stepsAt = vs ? 2 : Math.min(1, n - 2);
  if ((ui || entry?.steps.length) && stepsAt <= n - 2) mid.push({ type: ui?.type === 'dialer' ? 'dialer' : ui?.type === 'settings' && !APP_BRAND[entry!.source] ? 'settings' : 'app', from: stepsAt, to: Math.min(n - 2, stepsAt + 1), headline: { text: ui?.type === 'dialer' ? 'افتح الاتصال واكتب' : APP_BRAND[entry!.source] ? `افتح ${APP_BRAND[entry!.source]![0]}` : ui?.type === 'versus' ? `افتح ${ui.free.name}` : 'ادخل على الإعدادات', accent: ui?.type === 'dialer' ? 'الاتصال' : APP_BRAND[entry!.source]?.[0] ?? (ui?.type === 'versus' ? ui.free.name : 'الإعدادات'), tone: 'green' } });
  const next = mid.length ? mid.at(-1)!.to + 1 : 1;
  // The result in the entry's own words (short lines), not a generic sentence.
  const lines = (entry?.result ?? '').split(/[،,.]| و(?=\S)/).map((x) => x.trim()).filter((x) => x.length >= 6).map((x) => (x.length > 30 ? `${x.slice(0, 28)}…` : x)).slice(0, 3);
  if (next <= n - 2) mid.push({ type: 'statement', from: next, to: n - 2, headline: { text: entry?.onScreen ? `${entry.onScreen} ✓` : 'النتيجة', accent: entry?.onScreen }, icon: 'check', ...(lines.length ? { lines } : {}) });
  return [{ type: 'hook', from: 0, to: vs ? 0 : stepsAt - 1 < 0 ? 0 : stepsAt - 1, headline: { text: short }, icon: ui?.type === 'dialer' ? 'lock' : 'star' }, ...mid, { type: 'cta', from: n - 1, to: n - 1, headline: { text: 'جرّبها دلوقتي', accent: 'دلوقتي' } }];
}

// ── render ───────────────────────────────────────────────────────────────────────────────────────────────
export const motionAvailable = (rootDir: string) => existsSync(resolve(rootDir, 'node_modules/.bin/remotion')) && existsSync(resolve(rootDir, 'motion/index.ts'));

/** Draws the plan with Remotion into `out` (1080×1920 H.264 + the narration). */
export async function renderMotion(rootDir: string, plan: MotionPlan, audio: string, out: string): Promise<void> {
  const pub = resolve(dirname(out), `motion-public-${Date.now()}`);
  mkdirSync(pub, { recursive: true });
  try {
    cpSync(resolve(rootDir, 'motion/public/sfx'), resolve(pub, 'sfx'), { recursive: true });
    await stageProps(rootDir, plan, pub);
    // background music: a calm / uplifting licensed track (never the suspense ones for tips), ducked in the composition
    const musicDir = resolve(rootDir, 'music');
    if (existsSync(musicDir)) {
      const tracks = readdirSync(musicDir).filter((f) => /^(calm|inspiring)-.*\.(mp3|m4a|wav)$/i.test(f)).sort();
      if (tracks.length) {
        const pickT = tracks[Math.round(plan.duration * 100) % tracks.length]!;
        const ext = pickT.split('.').pop();
        copyFileSync(resolve(musicDir, pickT), resolve(pub, `music.${ext}`));
        plan.music = `music.${ext}`;
        writeFileSync(resolve(pub, 'props.json'), JSON.stringify(plan));
      }
    }
    // the sound-effects team's professional library (if built): its variants + peak times go with the plan
    const lib = resolve(rootDir, 'motion/public/sfx/lib/manifest.json');
    if (existsSync(lib)) { plan.sfxLib = JSON.parse(readFileSync(lib, 'utf8')); writeFileSync(resolve(pub, 'props.json'), JSON.stringify(plan)); }
    copyFileSync(audio, resolve(pub, plan.audio));
    const props = resolve(pub, 'props.json');
    writeFileSync(props, JSON.stringify(plan));
    // Standard limited-range yuv420p/bt709: Instagram rejected Remotion's default full-range (yuvj420p) uploads.
    await promisify(execFile)(resolve(rootDir, 'node_modules/.bin/remotion'), ['render', 'motion/index.ts', 'MotionShort', out, `--props=${props}`, `--public-dir=${pub}`, '--codec=h264', '--crf=20', '--pixel-format=yuv420p', '--color-space=bt709', '--log=error'], { cwd: rootDir, timeout: 20 * 60_000, maxBuffer: 32 * 1024 * 1024 });
    // Mastering: the platforms play everything at about -14 LUFS — loudness-normalise the final mix (two-pass
    // feel with a true-peak ceiling) so the voice is as loud as the videos around it; the picture is copied as is.
    const tmp = out.replace(/\.mp4$/, '.premaster.mp4');
    renameSync(out, tmp);
    await promisify(execFile)(ffmpegBin(), ['-y', '-v', 'error', '-i', tmp, '-c:v', 'copy', '-af', 'loudnorm=I=-14:TP=-1.5:LRA=9', '-ar', '48000', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out], { timeout: 5 * 60_000 });
    rmSync(tmp, { force: true });
  } finally { rmSync(pub, { recursive: true, force: true }); }
}

/**
 * Puts every 3D prop the plan uses into the render's public dir (downloaded once into data/prop-cache). A prop
 * that can't be fetched is removed from the plan — the video never fails because of an illustration.
 */
async function stageProps(rootDir: string, plan: MotionPlan, pub: string) {
  const cache = resolve(rootDir, 'data/prop-cache');
  mkdirSync(cache, { recursive: true }); mkdirSync(resolve(pub, 'props'), { recursive: true });
  const byFile = new Map(propNames().map((n) => [propFile(n), n]));
  const ok = new Set<string>();
  for (const src of new Set([...plan.scenes.flatMap((sc) => sc.props ?? []).map((x) => x.src), ...(plan.hero ? [plan.hero] : [])])) {
    const file = src.replace(/^props\//, '');
    const local = resolve(cache, file);
    try {
      if (!existsSync(local)) {
        const name = byFile.get(file);
        if (!name) continue;
        // CDN first, then GitHub itself; each with its own timeout.
        const path = propUrl(name).replace(catalog().base, '');
        let buf: Buffer | undefined;
        for (const url of [propUrl(name), `https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/${path}`, propUrl(name)]) {
          const r = await fetch(url, { signal: AbortSignal.timeout(25_000) }).catch(() => undefined);
          if (r?.ok) { buf = Buffer.from(await r.arrayBuffer()); break; }
        }
        if (!buf || buf.length < 1000) continue;
        writeFileSync(local, buf);
      }
      copyFileSync(local, resolve(pub, src));
      ok.add(src);
    } catch { /* skip this prop */ }
  }
  // animated versions (Google Noto, CC BY 4.0): downloaded once; a prop whose animation can't be fetched keeps its still image
  const anim = new Set<string>();
  for (const src of new Set(plan.scenes.flatMap((sc) => sc.props ?? []).map((x) => x.lottie).filter((x): x is string => Boolean(x)))) {
    const cp = src.match(/anim-([0-9a-f_]+)\.json$/)?.[1];
    const local = resolve(cache, `anim-${cp}.json`);
    try {
      if (!existsSync(local)) {
        const r = await fetch(`${catalog().animated_base}${cp}/lottie.json`, { signal: AbortSignal.timeout(25_000) }).catch(() => undefined);
        if (!r?.ok) continue;
        const txt = await r.text();
        JSON.parse(txt);
        writeFileSync(local, txt);
      }
      copyFileSync(local, resolve(pub, src));
      anim.add(src);
    } catch { /* keep the still image */ }
  }
  for (const sc of plan.scenes) for (const p of sc.props ?? []) if (p.lottie && !anim.has(p.lottie)) delete p.lottie;
  for (const sc of plan.scenes) if (sc.props) sc.props = sc.props.filter((x) => ok.has(x.src));
  if (plan.hero && !ok.has(plan.hero)) delete plan.hero;
  writeFileSync(resolve(pub, 'props.json'), JSON.stringify(plan));
}

export type { IconName };
