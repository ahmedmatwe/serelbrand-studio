/**
 * The sound & transitions team (expert rules). Every cut gets the transition that fits what comes next and a sound
 * that LANDS ON the cut (it starts 50 ms early; every transition sound peaks within ~25 ms and lasts ≤ 0.16 s).
 * Rules: strong moments (comparison, story, ending) punch with an impact; acted-out screens rise like UI cards;
 * phone steps whip sideways; result cards zoom in; two screens in a row alternate direction. Clicks tick, objects
 * pop softly, and sounds never pile up (anything within 0.1 s of a louder sound is dropped).
 */
import type { MotionScene } from './types';

export type Trans = 'whip' | 'zoom' | 'rise' | 'punch';
export type Sfx = [name: string, at: number, volume: number];

export function transitionFor(sc: MotionScene, prev?: MotionScene): Trans {
  if (!prev) return 'punch';
  switch (sc.type) {
    case 'versus': case 'story': case 'cta': return 'punch';
    case 'mock': return prev.type === 'mock' ? 'whip' : 'rise';
    case 'app': case 'dialer': case 'settings': return 'whip';
    default: return 'zoom';
  }
}

const CUT_SOUND: Record<Trans, [string, number]> = { punch: ['impact', 0.55], whip: ['swipe', 0.45], rise: ['swipe-up', 0.42], zoom: ['swipe-down', 0.45] };

export function soundPlan(scenes: MotionScene[]): { trans: Trans[]; sfx: Sfx[] } {
  const trans = scenes.map((sc, i) => transitionFor(sc, scenes[i - 1]));
  const raw: Sfx[] = [['impact', 0.02, 0.5]];
  scenes.forEach((sc, i) => {
    if (i > 0) { const [n, v] = CUT_SOUND[trans[i]!]; raw.push([n, Math.max(0, sc.start - 0.05), v]); }
    if (sc.type === 'dialer') sc.keys.forEach((k) => raw.push(['tap', k.at, 0.45]));
    if (sc.type === 'app') sc.at.forEach((a) => raw.push(['tick', a + 0.12, 0.4]));
    if (sc.type === 'settings') sc.at.slice(1).forEach((a) => raw.push(['tick', a, 0.4]));
    if (sc.type === 'mock') sc.items.forEach((it) => raw.push(['tick', it.at, 0.32]));
    if (sc.type === 'versus') raw.push(['impact', sc.freeAt, 0.4]);
    if (sc.type === 'alert' && sc.tone === 'bad') raw.push(['alert', sc.start + 0.1, 0.3]);
    (sc.props ?? []).forEach((p) => raw.push(['pop', p.at, 0.22]));
  });
  // never pile up: keep the louder of two sounds closer than 0.1 s
  const sorted = raw.sort((a, b) => a[1] - b[1]);
  const sfx: Sfx[] = [];
  for (const s of sorted) {
    const last = sfx.at(-1);
    if (last && s[1] - last[1] < 0.1) { if (s[2] > last[2]) sfx[sfx.length - 1] = s; continue; }
    sfx.push(s);
  }
  return { trans, sfx };
}
