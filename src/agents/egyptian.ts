/**
 * The Egyptian editor: the narrator must speak ONLY Egyptian colloquial Arabic (عامية مصرية). The voice reads
 * exactly the text it gets, and the writers sometimes slip into formal Arabic ("بعد ذلك"، "يمكنك أيضاً"، "قد تتطلب").
 * Right before the voice, every sentence is checked for formal markers; a sentence that has any is rewritten in
 * natural Cairene Egyptian with the SAME information (codes, numbers, app names, steps untouched) — and the
 * rewrite is only accepted if it lost no code/number, kept its length, and really removed the formal words.
 */
import { z } from 'zod';
import type { AgentContext } from './base.ts';

/** Formal (فصحى) markers that never belong in the narration. */
const FORMAL = /(?<![؀-ۿ])(?:[وف](?=[؀-ۿ]{3}))?(ذلك|هذا|هذه|هؤلاء|يمكنك|يمكن|سوف|قد(?= [يتن])|أيضاً|ايضا|أيضا|بدلاً|بدلا|تماماً|الذي|التي|الذين|لكي|حيث|ليس|لا يوجد|عندما|إذا|لذلك|ثم|فقط|كذلك|إلى|عليك|قم|اضغط|انقر|ستتحرك|ستظهر|سيظهر|ستجد|تستطيع|باهظ|دقيقة واحدة فقط|الآن)(?![؀-ۿ])/g;
export const formalWords = (t: string) => [...t.matchAll(FORMAL)].map((m) => m[1]!);
const keep = (t: string) => [...t.matchAll(/[*#]?[\d*#]{2,}[#]?|[A-Za-z][\w.+-]*/g)].map((m) => m[0]);

export async function egyptianize(ctx: AgentContext, texts: string[], videoId?: string): Promise<string[]> {
  const idx = texts.map((t, i) => (formalWords(t).length ? i : -1)).filter((i) => i >= 0);
  if (!idx.length || ctx.providers.llm.name.startsWith('mock')) return texts;
  const r = await ctx.providers.llm.generateJson({
    task: 'dialect.egyptian', tier: 'writing',
    system: 'You are the Egyptian dialect editor of a Cairo phone-tips channel. Rewrite each text so it is 100% natural spoken Egyptian colloquial Arabic (عامية مصرية قاهرية) — the way a friend from Cairo talks — with EXACTLY the same information, order and length (±15%). ' +
      'Never formal Arabic: ذلك→ده/دي، هذا→ده، يمكنك→تقدر، سوف/ستـ→هـ، قد يحتاج→ممكن يحتاج، أيضاً→كمان، بدلاً من→بدل ما، تماماً→خالص/على طول، الذي/التي→اللي، لكي→عشان، عندما→لما، إذا→لو، فقط→بس، إلى→لـ/على، الآن→دلوقتي، اضغط→دوس، ثم→وبعدين. ' +
      'Keep every code, number, English app/feature name and step exactly as written. No new facts, no emojis. JSON only.',
    prompt: JSON.stringify({ texts: idx.map((i) => ({ i, text: texts[i] })) }),
    schema: z.object({ texts: z.array(z.object({ i: z.number().int(), text: z.string() })) }),
    videoId, maxOutputTokens: 6000,
  }).catch(() => undefined);
  const out = [...texts];
  for (const x of (r?.data as { texts: { i: number; text: string }[] } | undefined)?.texts ?? []) {
    const orig = texts[x.i];
    if (orig === undefined) continue;
    const t = x.text.trim();
    const ok = keep(orig).every((k) => t.includes(k)) && t.length >= orig.length * 0.8 && t.length <= orig.length * 1.25 && formalWords(t).length < formalWords(orig).length;
    if (ok) out[x.i] = t;
  }
  return out;
}
