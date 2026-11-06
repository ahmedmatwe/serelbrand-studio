import { Agent, clamp, levelScore } from './base.ts';
import { TrendResearchLLM, type TopicIdea } from './schemas.ts';
import type { TrendSignal } from '../providers/media.ts';
import { loadPrompt } from '../prompts.ts';

export interface TrendResearchInput { niche: string; seedQueries?: string[]; country?: string; count?: number }
export interface TrendResearchOutput { niche: string; country: string; ideas: TopicIdea[] }

/** Deterministic opportunity score (0–100) combining LLM judgement with trend signals. */
export function opportunityScore(idea: Omit<TopicIdea, 'opportunityScore' | 'scoreBreakdown'>, signal?: TrendSignal) {
  const demand = signal?.interest ?? 50;
  const momentum =
    idea.trendStatus === 'evergreen' ? 60 : idea.trendStatus === 'declining' ? 20 : clamp(50 + (signal?.momentum ?? 0) * 50);
  const competitionGap = (levelScore(idea.competition, true) + (100 - (signal?.competition ?? 50))) / 2;
  const breakdown = {
    demand: demand * 0.25,
    momentum: momentum * 0.1,
    competitionGap: competitionGap * 0.2,
    monetization: levelScore(idea.monetization) * 0.2,
    copyrightSafety: levelScore(idea.copyrightRisk, true) * 0.1,
    policySafety: levelScore(idea.policyRisk, true) * 0.1,
    formatFit: (idea.recommendedFormat === 'both' ? 100 : 70) * 0.05,
  };
  const total = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return {
    score: Math.round(clamp(total)),
    breakdown: Object.fromEntries(Object.entries(breakdown).map(([k, v]) => [k, Number(v.toFixed(1))])),
  };
}

export class TrendResearchAgent extends Agent<TrendResearchInput, TrendResearchOutput> {
  readonly name = 'trend-research';
  readonly artifactKind = 'topic_ideas';

  protected async execute(input: TrendResearchInput): Promise<TrendResearchOutput> {
    const country = input.country ?? this.ctx.config.channel.targetCountries[0]!;
    const { channel } = this.ctx.config;
    const res = await this.ctx.providers.llm.generateJson({
      task: 'trends.ideas',
      tier: 'light',
      system: loadPrompt('trend-research'),
      prompt: JSON.stringify({ niche: input.niche, audience: channel.audience, countries: channel.targetCountries, seeds: input.seedQueries ?? [], count: input.count ?? 10 }),
      schema: TrendResearchLLM,
      vars: { niche: input.niche },
    });
    const signals = await this.ctx.providers.trends.signals(res.data.ideas.map((i) => i.seedQuery), country);
    const byQuery = new Map(signals.map((s) => [s.query, s]));
    const ideas: TopicIdea[] = res.data.ideas
      .map((idea) => {
        const { score, breakdown } = opportunityScore(idea, byQuery.get(idea.seedQuery));
        return { ...idea, opportunityScore: score, scoreBreakdown: breakdown };
      })
      .sort((a, b) => b.opportunityScore - a.opportunityScore);
    return { niche: input.niche, country, ideas };
  }
}
