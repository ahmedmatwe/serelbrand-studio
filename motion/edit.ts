/**
 * The sound & transitions team (expert rules). Every cut gets the transition that fits what comes next and a sound
 * that LANDS ON the cut (it starts 50 ms early; every transition sound peaks within ~25 ms and lasts ≤ 0.16 s).
 * Rules: strong moments (comparison, story, ending) punch with an impact; acted-out screens rise like UI cards;
 * phone steps whip sideways; result cards zoom in; two screens in a row alternate direction. Clicks tick, objects
 * pop softly, and sounds never pile up (anything within 0.1 s of a louder sound is dropped).
 */
import type { MotionScene } from './types.ts';

export type Trans = 'whip' | 'zoom' | 'rise' | 'punch';
/** [public file, start (s), volume, optional max length (s)] */
export type Sfx = [file: string, at: number, volume: number, maxDur?: number];
export type SfxLib = Record<string, { file: string; peak: number; dur: number }[]>;

export function transitionFor(sc: MotionScene, prev?: MotionScene): Trans {
  if (!prev) return 'punch';
  switch (sc.type) {
    case 'versus': case 'story': case 'cta': return 'punch';
    case 'mock': return prev.type === 'mock' ? 'whip' : 'rise';
    case 'app': case 'dialer': case 'settings': return 'whip';
    default: return 'zoom';
  }
}

/**
 * Professional mix rules (the sound team): effects SUPPORT the voice — soft, few, one consistent family per video.
 * - every cut: the SAME whoosh of this video (one family, chosen per video), soft; a hit only to open and close;
 * - clicks only where the pointer really clicks; meaningful sounds (shutter, register, notification, typing) soft;
 * - no cartoon pops on objects; anything under a spoken word is lowered (the voice always wins);
 * - never two sounds within 0.12 s.
 */
const VOL = { cut: 0.26, rise: 0.22, hit: 0.32, click: 0.15, meaning: 0.24, typing: 0.16, good: 0.22, bad: 0.18 };
const FALLBACK: Record<string, string> = { impact: 'impact', whoosh: 'swipe', 'swipe-up': 'swipe-up', click: 'tick', notify: 'pop', success: 'pop', error: 'alert' };
const PROP_SOUND: [RegExp, string][] = [[/camera/, 'camera'], [/money|coin|banknote|credit_card|dollar/, 'cash'], [/bell/, 'notify']];
const CLICKED = new Set(['checklist', 'ranked', 'notify', 'price', 'search', 'doc']);

export function soundPlan(scenes: MotionScene[], lib: SfxLib = {}, speech: { a: number; b: number }[] = [], seed = 0): { trans: Trans[]; sfx: Sfx[] } {
  const trans = scenes.map((sc, i) => transitionFor(sc, scenes[i - 1]));
  // one family per video: the same variant of each role all through this video (varies between videos)
  const pick = (role: string): { file: string; peak: number } | undefined => {
    const vs = lib[role];
    if (vs?.length) return vs[Math.abs(seed) % vs.length]!;
    const fb = FALLBACK[role];
    return fb ? { file: `sfx/${fb}.wav`, peak: 0.02 } : undefined;
  };
  const raw: Sfx[] = [];
  const add = (role: string, at: number, vol: number, alignPeak = false, maxDur?: number) => {
    const s = pick(role);
    if (s) raw.push([s.file, Math.max(0, at - (alignPeak ? s.peak : 0)), vol, maxDur]);
  };
  add('impact', 0.02, VOL.hit);
  scenes.forEach((sc, i) => {
    if (i > 0) {
      const t = trans[i]!;
      if (sc.type === 'cta') add('impact', sc.start, VOL.hit, true);
      else add(t === 'rise' ? 'swipe-up' : 'whoosh', sc.start, t === 'rise' ? VOL.rise : VOL.cut, true);
    }
    if (sc.type === 'dialer') sc.keys.forEach((k: { at: number }) => raw.push(['sfx/tap.wav', k.at, 0.3]));
    if (sc.type === 'app') sc.at.forEach((a: number) => add('click', a + 0.12, VOL.click));
    if (sc.type === 'settings') sc.at.slice(1).forEach((a: number) => add('click', a, VOL.click));
    if (sc.type === 'mock') {
      if (sc.kind === 'search' && sc.title && lib.typing?.length) add('typing', sc.start + 0.25, VOL.typing, false, Math.max(0.4, (sc.items[0]?.at ?? sc.start + 1.6) - sc.start - 0.4));
      if (sc.kind === 'notify') sc.items.forEach((it) => add('notify', it.at, VOL.meaning));
      else if (CLICKED.has(sc.kind)) sc.items.forEach((it) => add('click', it.at, VOL.click));
      if (sc.final) add(sc.final.tone === 'good' ? 'success' : 'error', sc.final.at, sc.final.tone === 'good' ? VOL.good : VOL.bad);
    }
    if (sc.type === 'diagram') sc.nodes.forEach((n: { at: number }) => add('click', n.at, VOL.click));
    if (sc.type === 'versus') add('success', sc.freeAt, VOL.good);
    if (sc.type === 'alert' && sc.tone === 'bad') add('error', sc.start + 0.1, VOL.bad);
    (sc.props ?? []).forEach((p) => { const r = PROP_SOUND.find(([re]) => re.test(p.src))?.[1]; if (r) add(r, p.at, VOL.meaning); });
  });
  // the voice wins: a sound starting under a spoken word is lowered by 35 %
  const talking = (t: number) => speech.some((w) => t >= w.a && t < w.b);
  const sorted = raw.sort((a, b) => a[1] - b[1]).map((x): Sfx => [x[0], x[1], Number((talking(x[1] + 0.03) ? x[2] * 0.65 : x[2]).toFixed(3)), x[3]]);
  const sfx: Sfx[] = [];
  for (const x of sorted) {
    const last = sfx.at(-1);
    if (last && x[1] - last[1] < 0.12) { if (x[2] > last[2]) sfx[sfx.length - 1] = x; continue; }
    sfx.push(x);
  }
  return { trans, sfx };
}
