/**
 * Self-healing for a phone-secrets Shorts pack, right after fact verification: every Short is checked ON ITS
 * OWN (complete narration, at least one verified fact, clear start). A broken Short is rewritten from its
 * reviewed library entry; if that fails twice it is swapped for another unused secret. The other Shorts are
 * never touched, so one bad Short can no longer sink the whole pack.
 */
import { z } from 'zod';
import type { AgentContext } from './base.ts';
import { countWords } from './base.ts';
import type { CheckedClaim, Script } from './schemas.ts';
import { loadPhoneLibrary, pickPhoneSecrets, secretSource, type PhoneSecret } from './niche/phone-library.ts';
import { PHONE_SHORT_RULES } from './scriptwriter.ts';

const MIN_WORDS = 45;
const SceneLLM = z.object({ voiceover: z.string().min(40), curiosityGap: z.string().default('') });

type Topic = { title: string; subject: string; angle: string; kind?: string; sourceUrl?: string };

/** Which Shorts are broken and why (pure). */
export function brokenShorts(script: Pick<Script, 'scenes'>, claims: Pick<CheckedClaim, 'sceneN' | 'status'>[]): { index: number; why: string }[] {
  return script.scenes.flatMap((sc, index) => {
    const words = countWords(sc.voiceover);
    const verified = claims.filter((c) => c.sceneN === sc.n && c.status === 'verified').length;
    const why = words < MIN_WORDS ? `only ${words} spoken words` : verified === 0 ? 'no verified fact' : '';
    return why ? [{ index, why }] : [];
  });
}

/** Writes ONE Short from its library entry (nothing else may be said). */
async function writeShort(ctx: AgentContext, videoId: string, entry: PhoneSecret, url: string, dialect: string): Promise<{ voiceover: string; curiosityGap: string } | undefined> {
  const r = await ctx.providers.llm.generateJson({
    task: 'pack.repair',
    tier: 'writing',
    system: `You write ONE YouTube Short narration. ${PHONE_SHORT_RULES} Return {"voiceover":"…","curiosityGap":"…"}. JSON only.`,
    prompt: JSON.stringify({ topic: entry.title, dialect, source: secretSource({ sources: { x: url }, secrets: [] }, { ...entry, source: 'x' }).excerpt, rule: 'Every step, code and fact must come from source; say the code symbol by symbol.' }),
    schema: SceneLLM,
    videoId,
    maxOutputTokens: 2000,
  }).catch(() => undefined);
  return r && countWords(r.data.voiceover) >= MIN_WORDS ? r.data : undefined;
}

/**
 * Repairs broken Shorts in place (script + calendar topics). `verify` re-extracts and re-checks the claims of
 * the current script. Returns the final claims and a log of what was repaired.
 */
export async function repairPack(ctx: AgentContext, videoId: string, verify: () => Promise<CheckedClaim[]>, claims: CheckedClaim[]): Promise<{ claims: CheckedClaim[]; log: string[] }> {
  if (!brokenShorts(ctx.repos.artifacts.latest<Script>(videoId, 'script')!.data, claims).length) return { claims, log: [] };
  const lib = loadPhoneLibrary(ctx.config.rootDir);
  const cal = ctx.repos.artifacts.latest<{ topics?: Topic[] } & Record<string, unknown>>(videoId, 'calendar_entry')?.data;
  const log: string[] = [];
  if (!lib || !cal?.topics?.length) return { claims, log };
  const tries = new Map<number, number>();
  for (let round = 0; round < 3; round++) {
    const script = ctx.repos.artifacts.latest<Script>(videoId, 'script')!.data;
    const broken = brokenShorts(script, claims);
    if (!broken.length) break;
    const scenes = [...script.scenes];
    for (const b of broken) {
      const n = (tries.get(b.index) ?? 0) + 1;
      tries.set(b.index, n);
      let entry = lib.secrets.find((x) => x.id === cal.topics![b.index]?.subject);
      // Second failure on the same secret: swap it for another unused one.
      if (!entry || n > 2) {
        const used = new Set([
          ...ctx.repos.artifacts.listKind<{ topics?: { subject: string }[] }>('calendar_entry').flatMap((a) => (a.data.topics ?? []).map((t) => t.subject)),
          ...cal.topics.map((t) => t.subject),
        ]);
        entry = pickPhoneSecrets(lib, used, 1)[0];
        if (!entry) { log.push(`Short ${b.index + 1}: ${b.why}; no unused secret left to swap in`); continue; }
        cal.topics[b.index] = { title: entry.title, subject: entry.id, angle: `${entry.steps.join(' ← ')} → ${entry.result}`, kind: entry.kind, sourceUrl: lib.sources[entry.source] ?? '' };
        log.push(`Short ${b.index + 1}: ${b.why} → swapped for "${entry.title}"`);
      } else log.push(`Short ${b.index + 1}: ${b.why} → rewritten from its library entry`);
      const w = await writeShort(ctx, videoId, entry, lib.sources[entry.source] ?? '', ctx.config.channel.dialect);
      if (w) scenes[b.index] = { ...scenes[b.index]!, voiceover: w.voiceover, curiosityGap: w.curiosityGap || scenes[b.index]!.curiosityGap, onScreenText: entry.onScreen };
    }
    ctx.repos.artifacts.save({ videoId, kind: 'calendar_entry', agent: 'pack-repair', data: cal });
    const fixed = { ...script, scenes };
    ctx.repos.artifacts.save({ videoId, kind: 'script', agent: 'pack-repair', data: { ...fixed, wordCount: countWords(scenes.map((s) => s.voiceover).join(' ')) } });
    // The research file must cover any swapped-in secret, so the verifier and later steps see its source.
    ctx.repos.artifacts.save({ videoId, kind: 'research', agent: 'pack-repair', data: { queries: cal.topics.map((t) => t.subject), sources: cal.topics.flatMap((t) => { const e = lib.secrets.find((x) => x.id === t.subject); return e ? [secretSource(lib, e)] : []; }) } });
    claims = await verify();
  }
  const final = ctx.repos.artifacts.latest<Script>(videoId, 'script')!.data;
  const left = brokenShorts(final, claims);
  if (left.length && left.length < final.scenes.length) {
    // Held back from upload (see packExclusions): its claims can't block the good Shorts of the pack.
    const held = left.map((b) => final.scenes[b.index]!.n);
    claims = claims.filter((c) => !held.includes(c.sceneN ?? -1));
    log.push(`Held back (not uploaded): ${left.map((b) => `Short ${b.index + 1} (${b.why})`).join(', ')}`);
  } else if (left.length) log.push(`Still broken after repair: ${left.map((b) => `Short ${b.index + 1} (${b.why})`).join(', ')}`);
  return { claims, log };
}
