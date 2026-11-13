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

const CUT_SOUND: Record<Trans, [string, number]> = { punch: ['impact', 0.55], whip: ['whoosh', 0.5], rise: ['swipe-up', 0.45], zoom: ['whoosh', 0.45] };
/** Built-in fallbacks (synthesised) when the professional library has no sound for a role. */
const FALLBACK: Record<string, string> = { impact: 'impact', whoosh: 'swipe', 'swipe-up': 'swipe-up', click: 'tick', pop: 'pop', notify: 'pop', success: 'pop', error: 'alert', camera: 'tick', cash: 'pop', typing: '' };
/** 3D objects that have their own sound. */
const PROP_SOUND: [RegExp, string][] = [[/camera/, 'camera'], [/money|coin|banknote|credit_card|dollar/, 'cash'], [/bell/, 'notify']];

/**
 * Every sound of the video. With the library, a cut sound starts so that ITS PEAK lands on the cut, variants rotate
 * (never the same whoosh twice in a row), and meaningful moments get meaningful sounds: shutter for a camera, a
 * register for money, a notification for notifications, typing while a search is typed, a chime for a good result.
 */
export function soundPlan(scenes: MotionScene[], lib: SfxLib = {}): { trans: Trans[]; sfx: Sfx[] } {
  const trans = scenes.map((sc, i) => transitionFor(sc, scenes[i - 1]));
  const turn: Record<string, number> = {};
  const pick = (role: string): { file: string; peak: number } | undefined => {
    const vs = lib[role];
    if (vs?.length) { const k = (turn[role] = ((turn[role] ?? -1) + 1)) % vs.length; return vs[k]!; }
    const fb = FALLBACK[role];
    return fb ? { file: `sfx/${fb}.wav`, peak: 0.02 } : undefined;
  };
  const raw: Sfx[] = [];
  const add = (role: string, at: number, vol: number, alignPeak = false, maxDur?: number) => {
    const s = pick(role);
    if (s) raw.push([s.file, Math.max(0, at - (alignPeak ? s.peak : 0)), vol, maxDur]);
  };
  add('impact', 0.02, 0.5);
  scenes.forEach((sc, i) => {
    if (i > 0) { const [role, v] = CUT_SOUND[trans[i]!]; add(role, sc.start, v, true); }
    if (sc.type === 'dialer') sc.keys.forEach((k: { at: number }) => raw.push(['sfx/tap.wav', k.at, 0.45]));
    if (sc.type === 'app') sc.at.forEach((a: number) => add('click', a + 0.12, 0.4));
    if (sc.type === 'settings') sc.at.slice(1).forEach((a: number) => add('click', a, 0.4));
    if (sc.type === 'mock') {
      if (sc.kind === 'search' && sc.title && lib.typing?.length) add('typing', sc.start + 0.25, 0.35, false, Math.max(0.4, (sc.items[0]?.at ?? sc.start + 1.6) - sc.start - 0.4));
      sc.items.forEach((it) => add(sc.kind === 'notify' ? 'notify' : 'click', it.at, sc.kind === 'notify' ? 0.4 : 0.32));
      if (sc.final) add(sc.final.tone === 'good' ? 'success' : 'error', sc.final.at, 0.4);
    }
    if (sc.type === 'versus') add('success', sc.freeAt, 0.4);
    if (sc.type === 'alert' && sc.tone === 'bad') add('error', sc.start + 0.1, 0.32);
    (sc.props ?? []).forEach((p) => { const r = PROP_SOUND.find(([re]) => re.test(p.src))?.[1]; add(r ?? 'pop', p.at, r ? 0.38 : 0.22); });
  });
  // never pile up: keep the louder of two sounds closer than 0.1 s
  const sorted = raw.sort((a, b) => a[1] - b[1]);
  const sfx: Sfx[] = [];
  for (const x of sorted) {
    const last = sfx.at(-1);
    if (last && x[1] - last[1] < 0.1) { if (x[2] > last[2]) sfx[sfx.length - 1] = x; continue; }
    sfx.push(x);
  }
  return { trans, sfx };
}
