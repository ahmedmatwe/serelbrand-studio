/**
 * Error memory: every error a cycle hits is remembered by its "signature" (the message without ids, numbers or
 * quoted names). When the same error comes back, the team studies it once: the cause, and a prevention rule that
 * goes to the writers' lessons (read before every script) when the agents can avoid it themselves — or, when only
 * a code change can, one Telegram alert to the owner. Nothing is reported twice.
 */
import { z } from 'zod';
import type { AgentContext } from '../agents/base.ts';

export interface ErrorEntry { count: number; first: string; last: string; sample: string; lesson?: string; cause?: string; needsCode?: boolean; alerted?: boolean }
export type ErrorMemory = Record<string, ErrorEntry>;

/** Same problem → same signature, whatever the ids, numbers, titles or URLs in the message. */
export function errorSignature(msg: string): string {
  return msg.toLowerCase()
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/vid_[a-z0-9]+|[a-f0-9]{12,}|\b[a-z0-9_-]{20,}\b/g, '<id>')
    .replace(/["«“'][^"»”']{1,80}["»”']/g, '<q>')
    .replace(/(?<!http |\(#)\d+(\.\d+)?/g, '#') // keep HTTP status and Meta error codes: 403 ≠ 500
    .replace(/\s+/g, ' ').trim().slice(0, 140);
}

export function errorMemory(ctx: AgentContext): ErrorMemory {
  return { ...(ctx.repos.artifacts.latest<{ sigs: ErrorMemory }>(null, 'error_memory')?.data.sigs ?? {}) };
}

/** Adds this cycle's errors; returns the memory (saved). */
export function rememberErrors(ctx: AgentContext, errors: string[], now = new Date()): ErrorMemory {
  const mem = errorMemory(ctx);
  if (!errors.length) return mem;
  for (const e of errors) {
    const sig = errorSignature(e);
    const x = mem[sig];
    mem[sig] = x ? { ...x, count: x.count + 1, last: now.toISOString(), sample: e.slice(0, 300) } : { count: 1, first: now.toISOString(), last: now.toISOString(), sample: e.slice(0, 300) };
  }
  ctx.repos.artifacts.save({ videoId: null, kind: 'error_memory', agent: 'errors', data: { sigs: mem } });
  return mem;
}

const Diagnosis = z.object({ items: z.array(z.object({
  sig: z.string(),
  component: z.enum(['research', 'script', 'hook', 'title', 'voice', 'render', 'motion', 'publish', 'social', 'comments', 'analytics', 'llm', 'other']),
  cause: z.string().max(200),
  needsCode: z.boolean(),
  prevention: z.string().max(220).default(''),
})) });

/**
 * Studies every error that came back (≥ 2 times) and has no lesson yet. Returns Arabic alert lines for the ones
 * only a code change can fix (each sent once).
 */
export async function learnFromErrors(ctx: AgentContext, now = new Date()): Promise<{ lessons: string[]; alerts: string[] }> {
  const mem = errorMemory(ctx);
  const todo = Object.entries(mem).filter(([, e]) => e.count >= 2 && !e.cause).slice(0, 6);
  if (!todo.length || ctx.providers.llm.name.startsWith('mock')) return { lessons: [], alerts: [] };
  const r = await ctx.providers.llm.generateJson({
    task: 'errors.diagnose', tier: 'light',
    system: 'You are the reliability engineer of an automated YouTube/Facebook/Instagram Shorts studio (research → script → hook/title → Gemini voice → render (stock or motion graphics) → publish → social → comments → analytics). ' +
      'For each recurring error: the component, the likely cause in one short sentence of simple Egyptian Arabic, needsCode = true when only a programmer can fix it (API changes, permissions, crashes, timeouts, config), false when the AI writers/editors can avoid it by working differently. ' +
      'prevention = when needsCode is false, ONE imperative English rule the team reads before every script (specific, testable); else "". JSON only.',
    prompt: JSON.stringify({ errors: todo.map(([sig, e]) => ({ sig, count: e.count, sample: e.sample })) }),
    schema: Diagnosis, maxOutputTokens: 1500,
  }).catch(() => undefined);
  const lessons: string[] = [];
  const alerts: string[] = [];
  const have = new Set(ctx.repos.knowledge.byCategory('lesson').map((k) => k.insight));
  for (const d of (r?.data as z.infer<typeof Diagnosis> | undefined)?.items ?? []) {
    const e = mem[d.sig];
    if (!e) continue;
    e.cause = d.cause; e.needsCode = d.needsCode;
    if (!d.needsCode && d.prevention) {
      const lesson = `Error (${d.component}): ${d.prevention}`;
      if (!have.has(lesson)) ctx.repos.knowledge.add({ category: 'lesson', insight: lesson, evidence: e.sample, confidence: now.getTime() / 1e13, sampleSize: e.count });
      e.lesson = lesson; lessons.push(lesson);
    } else if (d.needsCode && !e.alerted) {
      e.alerted = true;
      alerts.push(`🛠️ خطأ بيتكرر (${e.count} مرات) في ${d.component}: ${d.cause}\nقولّي في الشات «صلّح الخطأ ده» وأنا أصلّحه.\n${e.sample.slice(0, 160)}`);
    }
  }
  ctx.repos.artifacts.save({ videoId: null, kind: 'error_memory', agent: 'errors', data: { sigs: mem } });
  return { lessons, alerts };
}

/** Weekly report lines: what came back and what was done about it. */
export function errorSummary(ctx: AgentContext, now = new Date()): string[] {
  const week = now.getTime() - 7 * 86_400_000;
  return Object.values(errorMemory(ctx)).filter((e) => new Date(e.last).getTime() > week).sort((a, b) => b.count - a.count).slice(0, 5)
    .map((e) => `- ${e.cause ?? e.sample.slice(0, 90)} (${e.count}×) ${e.lesson ? '→ اتعلمنا منه ✅' : e.needsCode ? '→ محتاج تعديل في الكود 🛠️' : ''}`.trim());
}
