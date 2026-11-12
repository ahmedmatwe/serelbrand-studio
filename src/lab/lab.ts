/**
 * The lab: every part of the writing that has no learning loop yet is run as a live experiment. Each Short tries a
 * version (arm) of each knob (length, open loop, closing call to action); the numbers decide (views vs that
 * platform's usual, per Short); a clear winner becomes the default, clear losers are retired, and every week the
 * designer invents a new challenger for any knob with too few contenders — so the team never stops improving.
 */
import { z } from 'zod';
import type { AgentContext } from '../agents/base.ts';
import { allPosts } from '../analytics/learner.ts';
import { buildPerformance } from '../analytics/analyst.ts';

export interface Arm { id: string; ins: string; status: 'active' | 'winner' | 'retired'; born: string; by?: 'seed' | 'designer' }
export type LabState = Record<string, Arm[]>;
export interface LabAssign { secretId: string; arms: Record<string, string> }

const SEED: Record<string, [string, string][]> = {
  length: [
    ['w60', 'Length for this Short: 55–65 spoken words (about 25–30 s) — overrides the general length rule.'],
    ['w75', 'Length for this Short: 70–80 spoken words (about 32–37 s) — overrides the general length rule.'],
    ['w90', 'Length for this Short: 85–95 spoken words (about 40–45 s) — overrides the general length rule.'],
  ],
  loop: [
    ['loop', 'Keep the open loop: sentence 2 promises something true that is delivered last.'],
    ['direct', 'No open-loop sentence: go straight from the hook to the first step; no "استنى للآخر".'],
  ],
  cta: [
    ['share', 'Last sentence: ask to send it to one specific person who needs it (e.g. "ابعتها لحد بيتسرق منه الواي فاي").'],
    ['save', 'Last sentence: ask to save the video to try it later ("احفظ الفيديو عشان هتحتاجه").'],
    ['comment', 'Last sentence: a short question viewers answer in the comments about this exact tip.'],
    ['follow', 'Last sentence: tease the next secret and ask to follow for it (true, no dates).'],
  ],
};

export function labState(ctx: AgentContext): LabState {
  const saved = ctx.repos.artifacts.latest<{ knobs: LabState }>(null, 'lab_state')?.data.knobs ?? {};
  const out: LabState = {};
  for (const [k, arms] of Object.entries(SEED)) out[k] = saved[k]?.length ? saved[k]! : arms.map(([id, ins]) => ({ id, ins, status: 'active' as const, born: '2026-11-12', by: 'seed' as const }));
  return out;
}
const save = (ctx: AgentContext, knobs: LabState) => ctx.repos.artifacts.save({ videoId: null, kind: 'lab_state', agent: 'lab', data: { knobs } });

/** Per knob and arm: number of measured Shorts and mean log(views ÷ platform usual). */
export function labResults(ctx: AgentContext, now = new Date()): Record<string, Record<string, { n: number; score: number }>> {
  const assigns = ctx.repos.artifacts.listKind<{ items: LabAssign[] }>('lab_assign').flatMap((a) => a.data.items);
  const perf = new Map(buildPerformance(ctx, allPosts(ctx), now).filter((s) => s.secretId && s.results.length).map((s) => [s.secretId!, s.results.reduce((a, r) => a + Math.log(Math.max(0.05, r.vsPlatformUsual)), 0) / s.results.length]));
  const out: Record<string, Record<string, { sum: number; n: number }>> = {};
  for (const a of assigns) {
    const sc = perf.get(a.secretId);
    if (sc === undefined) continue;
    for (const [k, arm] of Object.entries(a.arms)) { const x = ((out[k] ??= {})[arm] ??= { sum: 0, n: 0 }); x.sum += sc; x.n++; }
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([a, x]) => [a, { n: x.n, score: Number((x.sum / x.n).toFixed(3)) }]))]));
}

/** Winner = ≥ 4 Shorts and clearly ahead; losers = ≥ 4 Shorts and clearly behind the leader (≈ 30% fewer views). */
export function judge(knobs: LabState, res: ReturnType<typeof labResults>): { knobs: LabState; changes: string[] } {
  const changes: string[] = [];
  for (const [k, arms] of Object.entries(knobs)) {
    const r = res[k] ?? {};
    const live = arms.filter((a) => a.status !== 'retired');
    const measured = live.filter((a) => (r[a.id]?.n ?? 0) >= 4).sort((a, b) => r[b.id]!.score - r[a.id]!.score);
    if (measured.length < 2) continue;
    const lead = measured[0]!;
    if (lead.status !== 'winner' && r[lead.id]!.score - r[measured[1]!.id]!.score >= 0.15) {
      for (const a of arms) if (a.status === 'winner') a.status = 'active';
      lead.status = 'winner'; changes.push(`${k}: ${lead.id} won`);
    }
    for (const a of measured.slice(1)) if (r[lead.id]!.score - r[a.id]!.score >= 0.35 && live.filter((x) => x.status !== 'retired').length > 2) { a.status = 'retired'; changes.push(`${k}: ${a.id} retired`); }
  }
  return { knobs, changes };
}

/** Picks an arm per knob for each Short: untested arms first, then mostly the best (winner) with some exploring. */
export function labAssign(ctx: AgentContext, secretIds: string[], rnd = Math.random, now = new Date()): Map<string, { arms: Record<string, string>; instructions: string[] }> {
  const knobs = labState(ctx);
  const res = labResults(ctx, now);
  const out = new Map<string, { arms: Record<string, string>; instructions: string[] }>();
  const usedNow: Record<string, string[]> = {};
  for (const id of secretIds) {
    const arms: Record<string, string> = {};
    const instructions: string[] = [];
    for (const [k, all] of Object.entries(knobs)) {
      const live = all.filter((a) => a.status !== 'retired');
      if (!live.length) continue;
      const n = (a: Arm) => (res[k]?.[a.id]?.n ?? 0) + (usedNow[k]?.filter((x) => x === a.id).length ?? 0);
      const young = live.filter((a) => n(a) < 3).sort((a, b) => n(a) - n(b));
      const best = [...live].sort((a, b) => Number(b.status === 'winner') - Number(a.status === 'winner') || (res[k]?.[b.id]?.score ?? 0) - (res[k]?.[a.id]?.score ?? 0))[0]!;
      const pick = young.length && rnd() < 0.6 ? young[0]! : rnd() < 0.75 ? best : live[Math.floor(rnd() * live.length)]!;
      arms[k] = pick.id; instructions.push(pick.ins);
      (usedNow[k] ??= []).push(pick.id);
    }
    out.set(id, { arms, instructions });
  }
  return out;
}

export function saveAssign(ctx: AgentContext, videoId: string, m: Map<string, { arms: Record<string, string> }>) {
  if (m.size) ctx.repos.artifacts.save({ videoId, kind: 'lab_assign', agent: 'lab', data: { items: [...m].map(([secretId, x]) => ({ secretId, arms: x.arms })) } });
}

/**
 * Weekly evolution: judge winners/losers, then for every knob with fewer than 3 live arms the designer writes one
 * new challenger (a different idea, learned from the winner and the retired ones). Returns report lines.
 */
export async function labEvolve(ctx: AgentContext, now = new Date()): Promise<string[]> {
  const last = ctx.repos.artifacts.latest<{ at: string }>(null, 'lab_evolve')?.data.at;
  if (last && now.getTime() - new Date(last).getTime() < 6.5 * 86_400_000) return [];
  const { knobs, changes } = judge(labState(ctx), labResults(ctx, now));
  const lines = [...changes];
  const thin = Object.entries(knobs).filter(([, a]) => a.filter((x) => x.status !== 'retired').length < 3);
  if (thin.length && !ctx.providers.llm.name.startsWith('mock')) {
    const r = await ctx.providers.llm.generateJson({
      task: 'lab.design', tier: 'light',
      system: 'You run experiments for "سر الموبايل" (Egyptian Arabic phone-tip Shorts). For each knob, invent ONE new version (a short instruction to the scriptwriter, English, imperative, testable) that is genuinely different from the live and retired ones and could beat the current winner. Keep it honest (no fake urgency, no false claims). id = short lowercase slug. JSON only.',
      prompt: JSON.stringify({ knobs: thin.map(([k, arms]) => ({ knob: k, arms: arms.map((a) => ({ id: a.id, ins: a.ins, status: a.status })), results: labResults(ctx, now)[k] ?? {} })) }),
      schema: z.object({ arms: z.array(z.object({ knob: z.string(), id: z.string().regex(/^[a-z0-9-]{2,20}$/), ins: z.string().min(15).max(260) })) }),
      maxOutputTokens: 1200,
    }).catch(() => undefined);
    for (const a of (r?.data as { arms: { knob: string; id: string; ins: string }[] } | undefined)?.arms ?? []) {
      const list = knobs[a.knob];
      if (!list || list.some((x) => x.id === a.id)) continue;
      list.push({ id: a.id, ins: a.ins, status: 'active', born: now.toISOString().slice(0, 10), by: 'designer' });
      lines.push(`${a.knob}: new challenger ${a.id}`);
    }
  }
  save(ctx, knobs);
  ctx.repos.artifacts.save({ videoId: null, kind: 'lab_evolve', agent: 'lab', data: { at: now.toISOString(), lines } });
  return lines;
}

/** Report lines in Arabic: each knob's arms with their score. */
export function labSummary(ctx: AgentContext, now = new Date()): string[] {
  const NAME: Record<string, string> = { length: 'طول الفيديو', loop: 'استنى للآخر', cta: 'آخر جملة' };
  const res = labResults(ctx, now);
  return Object.entries(labState(ctx)).map(([k, arms]) => `- ${NAME[k] ?? k}: ` + arms.filter((a) => a.status !== 'retired').map((a) => `${a.status === 'winner' ? '🏆' : ''}${a.id} ${res[k]?.[a.id] ? `×${Math.exp(res[k][a.id]!.score).toFixed(1)} (${res[k][a.id]!.n})` : '⏳'}`).join(' · '));
}
