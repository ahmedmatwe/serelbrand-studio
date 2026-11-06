/**
 * Each pipeline step as a queue job. A step loads its inputs from stored artifacts,
 * so any step can be re-run on its own after a failure or a human edit.
 */
import type { AgentContext } from '../agents/base.ts';
import { StudioError } from '../core/errors.ts';
import { NicheSelectorAgent } from '../agents/niche/niche-selector.ts';
import { TrendResearchAgent } from '../agents/trend-research.ts';
import { ContentStrategyAgent } from '../agents/content-strategy.ts';
import { ScriptwriterAgent } from '../agents/scriptwriter.ts';
import { FactCheckerAgent } from '../agents/fact-checker.ts';
import { ProductionPlannerAgent } from '../agents/production-planner.ts';
import { ThumbnailAgent } from '../agents/thumbnail.ts';
import { SeoAgent } from '../agents/seo.ts';
import { ComplianceAgent, type ComplianceReport } from '../agents/compliance.ts';
import { QualityAgent } from '../agents/quality.ts';
import type { Blueprint, FactCheckReport, Script, SeoPackage } from '../agents/schemas.ts';
import type { ThumbnailOutput } from '../agents/thumbnail.ts';
import { PublisherAgent } from '../publishing/publisher.ts';
import { AnalyticsAgent } from '../analytics/analytics.ts';
import { OptimizationAgent } from '../analytics/optimization.ts';
import { AutoVerifierAgent } from '../agents/auto-verifier.ts';
import { RendererAgent, type RenderOutput, type RenderSize } from '../media/renderer.ts';

export const AGENT_NAMES = [
  'niche-selector', 'trend-research', 'content-strategy', 'scriptwriter', 'fact-checker', 'auto-verifier',
  'production-planner', 'thumbnail', 'seo', 'renderer', 'compliance', 'quality', 'publisher', 'analytics', 'optimization',
] as const;

/** Production chain for one video, in dependency order. */
export const PRODUCTION_CHAIN = ['scriptwriter', 'fact-checker', 'production-planner', 'thumbnail', 'seo', 'compliance', 'quality'] as const;

function need<T>(ctx: AgentContext, videoId: string, kind: string): T {
  const a = ctx.repos.artifacts.latest<T>(videoId, kind);
  if (!a) throw new StudioError('MISSING_INPUT', `Video ${videoId} has no "${kind}" yet — run the previous step first`, false);
  return a.data;
}

export const steps = {
  'niche-selector': (ctx: AgentContext) => new NicheSelectorAgent(ctx).run({}),
  'trend-research': (ctx: AgentContext, p: { niche: string; country?: string }) => new TrendResearchAgent(ctx).run(p),
  'content-strategy': (ctx: AgentContext, p: { niche: string; startDate?: string; avoid?: string[] }) => {
    const ideas = ctx.repos.artifacts.latest<{ ideas: never[] }>(null, 'topic_ideas')?.data.ideas;
    return new ContentStrategyAgent(ctx).run({ ...p, ideas });
  },
  scriptwriter: (ctx: AgentContext, p: { videoId: string }) => {
    const v = ctx.repos.videos.get(p.videoId);
    if (!v) throw new StudioError('NOT_FOUND', `Video ${p.videoId} not found`);
    return new ScriptwriterAgent(ctx).run({ videoId: v.id, title: v.title, format: v.format });
  },
  'fact-checker': (ctx: AgentContext, p: { videoId: string }) =>
    new FactCheckerAgent(ctx).run({ videoId: p.videoId, script: need<Script>(ctx, p.videoId, 'script') }),
  'auto-verifier': (ctx: AgentContext, p: { videoId: string; maxRounds?: number }) => new AutoVerifierAgent(ctx).run(p),
  'production-planner': (ctx: AgentContext, p: { videoId: string }) =>
    new ProductionPlannerAgent(ctx).run({ videoId: p.videoId, script: need<Script>(ctx, p.videoId, 'script') }),
  thumbnail: (ctx: AgentContext, p: { videoId: string }) => {
    const s = need<Script>(ctx, p.videoId, 'script');
    return new ThumbnailAgent(ctx).run({ videoId: p.videoId, title: s.mainTitle, summary: s.opening });
  },
  seo: (ctx: AgentContext, p: { videoId: string }) =>
    new SeoAgent(ctx).run({
      videoId: p.videoId,
      script: need<Script>(ctx, p.videoId, 'script'),
      blueprint: need<Blueprint>(ctx, p.videoId, 'blueprint'),
      factCheck: ctx.repos.artifacts.latest<FactCheckReport>(p.videoId, 'fact_check')?.data,
    }),
  renderer: (ctx: AgentContext, p: { videoId: string; size?: RenderSize; shorts?: boolean }) => new RendererAgent(ctx).run(p),
  compliance: (ctx: AgentContext, p: { videoId: string; usesAIVoice?: boolean; usesRealisticSyntheticMedia?: boolean; syntheticDisclosureSet?: boolean }) => {
    const blueprint = need<Blueprint>(ctx, p.videoId, 'blueprint');
    const render = ctx.repos.artifacts.latest<RenderOutput>(p.videoId, 'render')?.data;
    // A render uses only renderer-made graphics; without one, assume the blueprint's generated imagery.
    // Realistic AI narration (Gemini voice) → disclose to be safe; robotic/mock voices and text cards do not need it.
    const usesGenerated = render ? render.voice.provider === 'gemini-tts' : blueprint.scenes.some((s) => s.assetSource === 'generated');
    return new ComplianceAgent(ctx).run({
      videoId: p.videoId,
      script: need<Script>(ctx, p.videoId, 'script'),
      factCheck: need<FactCheckReport>(ctx, p.videoId, 'fact_check'),
      blueprint,
      thumbnails: need<ThumbnailOutput>(ctx, p.videoId, 'thumbnails').concepts,
      seo: need<SeoPackage>(ctx, p.videoId, 'seo_package'),
      usesAIVoice: p.usesAIVoice ?? true,
      // Default to "disclose" whenever generated imagery is used: safer to over-disclose.
      usesRealisticSyntheticMedia: p.usesRealisticSyntheticMedia ?? usesGenerated,
      syntheticDisclosureSet: p.syntheticDisclosureSet ?? true,
      assets: render?.assets,
      renderVisualMode: render?.visualMode,
    });
  },
  quality: (ctx: AgentContext, p: { videoId: string }) =>
    new QualityAgent(ctx).run({
      videoId: p.videoId,
      script: need<Script>(ctx, p.videoId, 'script'),
      blueprint: need<Blueprint>(ctx, p.videoId, 'blueprint'),
      thumbnails: need<ThumbnailOutput>(ctx, p.videoId, 'thumbnails').concepts,
      seo: need<SeoPackage>(ctx, p.videoId, 'seo_package'),
      compliance: need<ComplianceReport>(ctx, p.videoId, 'compliance_report'),
      render: (() => {
        const r = ctx.repos.artifacts.latest<RenderOutput>(p.videoId, 'render')?.data;
        return r ? { audioScore: r.measurements.audioScore, visualScore: r.measurements.visualScore, subtitleAccuracy: r.measurements.subtitleAccuracy } : undefined;
      })(),
    }),
  publisher: (ctx: AgentContext, p: { videoId: string }) => new PublisherAgent(ctx).run(p),
  analytics: (ctx: AgentContext, p: { videoId: string; checkpoints?: number[]; hoursSincePublish?: number }) => new AnalyticsAgent(ctx).run(p),
  optimization: (ctx: AgentContext, p: { videoId: string }) => new OptimizationAgent(ctx).run(p),
} satisfies Record<(typeof AGENT_NAMES)[number], (ctx: AgentContext, payload: any) => Promise<unknown>>;

export type StepName = keyof typeof steps;

export function registerStepHandlers(ctx: AgentContext) {
  for (const [name, fn] of Object.entries(steps)) {
    ctx.queue.register(name, async (payload) => {
      await (fn as (c: AgentContext, p: unknown) => Promise<unknown>)(ctx, payload);
      return { ok: true };
    });
  }
}
