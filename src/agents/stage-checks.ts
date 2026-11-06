/**
 * Check-and-fix at every stage: each agent validates its own output right away and asks the model to
 * fix the exact problems (instead of discovering them at the final gate). Pure checks live here.
 */
import { countWords } from './base.ts';
import type { Script } from './schemas.ts';
import { spokenText } from './scriptwriter.ts';
import { duplicateSentenceRatio, policyHits, titleSupport, CLICKBAIT } from './compliance.ts';

/** Problems in a script that can be fixed by rewriting (not facts — those go to the verifier). */
export function scriptProblems(s: Pick<Script, 'hooks' | 'opening' | 'scenes' | 'cta' | 'ending'>, target?: { minWords: number; maxWords: number }): string[] {
  const p: string[] = [];
  const hook = s.hooks[0] ?? '';
  if (countWords(hook) > 30) p.push(`Hook 1 has ${countWords(hook)} words: make it ≤ 25 words, start with the shock/question directly.`);
  const first = s.scenes[0];
  if (!first?.curiosityGap && !/[؟?]/.test(hook + (first?.voiceover.slice(0, 200) ?? ''))) p.push('The first 10 seconds open no curiosity gap: add a clear question or mystery right at the start.');
  if (countWords(s.opening) < 8) p.push('The opening does not state the promise of the video: say in one sentence what the viewer will learn.');
  const text = spokenText(s);
  const dup = duplicateSentenceRatio(text);
  if (dup >= 0.1) p.push(`${Math.round(dup * 100)}% of sentences are repeated: remove the repetition and filler, replace it with new information.`);
  for (const h of policyHits(text)) p.push(`Policy risk: "${h.word}" (${h.kind}) — rephrase neutrally or remove.`);
  if (target) {
    const w = countWords(text);
    if (w > target.maxWords * 1.1) p.push(`Too long: ${w} words, max ${target.maxWords}. Cut the weakest parts.`);
  }
  return p;
}

/** Problems in a title (misleading vs the script, clickbait words). */
export function titleProblems(title: string, script: Pick<Script, 'opening' | 'scenes' | 'cta' | 'ending'>): string[] {
  const p: string[] = [];
  const support = titleSupport(title, spokenText(script));
  if (support < 0.4) p.push(`Only ${Math.round(support * 100)}% of the title's words appear in the video — the title must describe what the video really says.`);
  for (const w of CLICKBAIT) if (title.includes(w)) p.push(`Clickbait phrase "${w}" — use a specific, truthful promise.`);
  return p;
}
