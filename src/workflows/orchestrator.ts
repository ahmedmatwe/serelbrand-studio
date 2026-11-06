/**
 * Orchestrator: chains agent jobs into workflows. Every step is a durable queue job,
 * so a failed workflow can be resumed with `rerun` and continued with `review`.
 */
import type { AgentContext } from '../agents/base.ts';
import { StudioError } from '../core/errors.ts';
import type { Approval } from '../database/repositories.ts';
import { requestApproval } from '../publishing/approval.ts';
import type { PrePublicationReport } from '../reports/prepublication.ts';
import type { TrendResearchOutput } from '../agents/trend-research.ts';
import type { OptimizationReport } from '../analytics/optimization.ts';
import { PRODUCTION_CHAIN, steps, type StepName } from './steps.ts';

export interface StepOutcome { step: StepName; jobId: string; status: string; error?: string | null }

async function runJob(ctx: AgentContext, step: StepName, payload: unknown): Promise<StepOutcome> {
  const jobId = ctx.queue.enqueue(step, payload);
  await ctx.queue.drain();
  const j = ctx.queue.get(jobId)!;
  return { step, jobId, status: j.status, error: j.last_error };
}

export interface ProduceResult {
  videoId: string;
  steps: StepOutcome[];
  completed: boolean;
  report?: PrePublicationReport;
  approval?: Approval | null;
  message?: string;
}

/** idea → script → fact-check → blueprint → thumbnails → SEO → compliance → quality → approval request */
export async function produceVideo(
  ctx: AgentContext,
  o: { title: string; format?: 'long' | 'short'; niche?: string; fromStep?: StepName; videoId?: string; render?: boolean; renderSize?: 'full' | 'preview' },
): Promise<ProduceResult> {
  const videoId = o.videoId ?? ctx.repos.videos.create({ title: o.title, format: o.format ?? 'long', niche: o.niche }).id;
  const chain: StepName[] = [...PRODUCTION_CHAIN];
  if (o.render) chain.splice(chain.indexOf('compliance'), 0, 'renderer');
  // Strict automatic verification right after claim extraction (it may rewrite the script before production).
  if (ctx.config.env.AUTO_VERIFY) chain.splice(chain.indexOf('fact-checker') + 1, 0, 'auto-verifier');
  const start = o.fromStep ? chain.indexOf(o.fromStep) : 0;
  if (start < 0) throw new StudioError('USAGE', `"${o.fromStep}" is not a production step`);
  const outcomes: StepOutcome[] = [];
  for (const step of chain.slice(start)) {
    const r = await runJob(ctx, step, step === 'renderer' ? { videoId, size: o.renderSize } : { videoId });
    outcomes.push(r);
    if (r.status !== 'succeeded') {
      ctx.audit.record({ actor: 'orchestrator', action: 'workflow.halted', target: videoId, details: { step, status: r.status, error: r.error } });
      return { videoId, steps: outcomes, completed: false };
    }
  }
  const { report, approval, message } = requestApproval(ctx, videoId);
  return { videoId, steps: outcomes, completed: true, report, approval, message };
}

/** After a human edit (e.g. verified sources): re-run the gates and request approval again. */
export function review(ctx: AgentContext, videoId: string) {
  return produceVideo(ctx, { title: '', videoId, fromStep: 'compliance' });
}

export async function publish(ctx: AgentContext, videoId: string) {
  return runJob(ctx, 'publisher', { videoId });
}

/** Captures due analytics checkpoints, then diagnoses. */
export async function postPublish(ctx: AgentContext, videoId: string, hoursSincePublish: number): Promise<{ steps: StepOutcome[]; report?: OptimizationReport }> {
  const a = await runJob(ctx, 'analytics', { videoId, hoursSincePublish });
  if (a.status !== 'succeeded') return { steps: [a] };
  const o = await runJob(ctx, 'optimization', { videoId });
  return { steps: [a, o], report: ctx.repos.artifacts.latest<OptimizationReport>(videoId, 'optimization_report')?.data };
}

/** Daily: research → pick best idea not produced yet → produce it up to the approval request. */
export async function daily(ctx: AgentContext, niche: string) {
  await steps['trend-research'](ctx, { niche });
  const ideas = ctx.repos.artifacts.latest<TrendResearchOutput>(null, 'topic_ideas')!.data.ideas;
  const done = new Set(ctx.repos.videos.list().map((v) => v.title));
  const pick = ideas.find((i) => !done.has(i.title));
  if (!pick) return { picked: null, result: null };
  const format = pick.recommendedFormat === 'short' ? 'short' : 'long';
  return { picked: pick, result: await produceVideo(ctx, { title: pick.title, format, niche }) };
}
