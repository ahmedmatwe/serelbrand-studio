/**
 * Check-and-fix at every stage: each agent validates its own output right away and asks the model to
 * fix the exact problems (instead of discovering them at the final gate). Pure checks live here.
 */
import { countWords } from './base.ts';

const EGYPTIAN = ['إزاي', 'ازاي', 'ليه', 'ده', 'دي', 'دول', 'اللي', 'مش', 'عشان', 'علشان', 'كده', 'كدا', 'بتاع', 'بتاعة', 'دلوقتي', 'إيه', 'ايه', 'فين', 'امتى', 'إمتى', 'خالص', 'أوي', 'زي', 'بس'];
const FUSHA = ['لماذا', 'كيف', 'هذا', 'هذه', 'هؤلاء', 'الذي', 'التي', 'الذين', 'ليس', 'ليست', 'لأن', 'هكذا', 'الآن', 'ماذا', 'أين', 'متى', 'جداً', 'جدا', 'مثل', 'سوف', 'لقد'];
const tokensOf = (t: string) => t.replace(/[\p{M}\u0640]/gu, '').split(/[^\p{L}]+/u).filter(Boolean);
/** Words of the wrong register for the channel dialect (fusha ↔ Egyptian colloquial). */
export function wrongRegisterWords(text: string, dialect: string): string[] {
  const wrong = /egypt|masri|مصري/i.test(dialect) ? FUSHA : EGYPTIAN;
  const set = new Set(wrong.map((w) => w.replace(/[\p{M}]/gu, '')));
  return tokensOf(text).filter((w) => set.has(w));
}
import type { Script } from './schemas.ts';
import { spokenText } from './scriptwriter.ts';
import { duplicateSentenceRatio, policyHits, titleSupport, CLICKBAIT } from './compliance.ts';

/** Problems in a script that can be fixed by rewriting (not facts — those go to the verifier). */
export function scriptProblems(s: Pick<Script, 'hooks' | 'opening' | 'scenes' | 'cta' | 'ending'> & { format?: Script['format'] }, target?: { minWords: number; maxWords: number }, dialect?: string): string[] {
  const p: string[] = [];
  const hook = s.hooks[0] ?? '';
  if (countWords(hook) > 30) p.push(`Hook 1 has ${countWords(hook)} words: make it ≤ 25 words, start with the shock/question directly.`);
  const first = s.scenes[0];
  if (first && (!first.onScreenText.trim() || countWords(first.voiceover) < 8))
    p.push('Opening scene is not self-explanatory: give the subject a short on-screen label and a concrete first sentence.');
  if (first && /^(اهلا|أهلا|مرحبا|مرحباً|في هذا الفيديو|خلينا|دعونا)/i.test(first.voiceover.trim()))
    p.push('Opening starts with a greeting or generic intro: replace it with the concrete hook and viewer promise.');
  if (!first?.curiosityGap && !/[؟?]/.test(hook + (first?.voiceover.slice(0, 200) ?? ''))) p.push('The first 10 seconds open no curiosity gap: add a clear question or mystery right at the start.');
  if (countWords(s.opening) < 8) p.push('The opening does not state the promise of the video: say in one sentence what the viewer will learn.');
  const text = spokenText(s);
  const dup = duplicateSentenceRatio(text);
  if (dup >= 0.1) p.push(`${Math.round(dup * 100)}% of sentences are repeated: remove the repetition and filler, replace it with new information.`);
  if (dialect) {
    const wrong = wrongRegisterWords([...s.hooks, text].join(' '), dialect);
    // A couple of borderline words are fine; a pattern means mixed register.
    if (wrong.length >= 3) p.push(`Mixed Arabic register: the channel uses "${dialect}" but these words don't fit it: ${[...new Set(wrong)].slice(0, 8).join('، ')}. Rewrite them in the channel register everywhere.`);
  }
  // Same measure as the final quality gate (clarity): catching it here costs one rewrite, not a whole production.
  const sents = text.split(/[.!؟?\n]+/).map((x) => x.trim()).filter(Boolean);
  const avg = sents.reduce((a, x) => a + countWords(x), 0) / Math.max(1, sents.length);
  const longest = Math.max(0, ...sents.map(countWords));
  if (avg > 18 || longest > 30) p.push(`Sentences are too long (average ${avg.toFixed(0)} words, longest ${longest}): end every idea with a period or "!" — short spoken sentences of 6–15 words, one step per sentence (a settings path may stay in one sentence).`);
  for (const h of policyHits(text)) p.push(`Policy risk: "${h.word}" (${h.kind}) — rephrase neutrally or remove.`);
  if (target) {
    const w = countWords(text);
    if (w > target.maxWords * 1.1) p.push(`Too long: ${w} words, max ${target.maxWords}. Cut the weakest parts.`);
  }
  return p;
}

/** Problems in a title (misleading vs the script, clickbait words). */
export function titleProblems(title: string, script: Pick<Script, 'opening' | 'scenes' | 'cta' | 'ending'> & { format?: Script['format'] }, dialect?: string): string[] {
  const p: string[] = [];
  if (dialect) { const w = wrongRegisterWords(title, dialect); if (w.length) p.push(`Title register doesn't match the channel (${dialect}): ${w.join('، ')}`); }
  const support = titleSupport(title, spokenText(script));
  if (support < 0.4) p.push(`Only ${Math.round(support * 100)}% of the title's words appear in the video — the title must describe what the video really says.`);
  for (const w of CLICKBAIT) if (title.includes(w)) p.push(`Clickbait phrase "${w}" — use a specific, truthful promise.`);
  return p;
}
