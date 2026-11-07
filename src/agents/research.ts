/**
 * Source research BEFORE writing: the scriptwriter gets real Wikipedia text about the topic and may only use
 * numbers, dates, names and events that appear in it. The verifier then finds the same evidence, so facts
 * survive verification instead of being deleted (which left vague, empty scripts).
 */
import { z } from 'zod';
import type { AgentContext } from './base.ts';
import { relevantExcerpt } from './auto-verifier.ts';

export interface ResearchSource { url: string; title?: string; excerpt: string }

const QueriesLLM = z.object({ queries: z.array(z.string().min(2)).min(1).max(5) });

export async function researchTopic(ctx: AgentContext, videoId: string, topic: string, angle = ''): Promise<ResearchSource[]> {
  if (ctx.providers.web.name === 'mock-web') return []; // offline runs: no sources to fetch
  const q = await ctx.providers.llm.generateJson({
    task: 'research.queries',
    tier: 'light',
    system: 'You find sources for a documentary about a company or business story. Give 2–4 short ENGLISH Wikipedia search queries (article titles work best): the company, the product, the person or event at the heart of the topic. JSON only.',
    prompt: JSON.stringify({ topic, angle }),
    schema: QueriesLLM,
    videoId,
    maxOutputTokens: 1000,
  }).catch(() => undefined);
  const queries = q?.data.queries ?? [];
  const seen = new Set<string>();
  const out: ResearchSource[] = [];
  for (const query of queries.slice(0, 4)) {
    const pages = await ctx.providers.web.wikipedia(query, 'en', 1).catch(() => []);
    for (const p of pages) {
      if (!p.text || seen.has(p.url)) continue;
      seen.add(p.url);
      out.push({ url: p.url, title: p.title, excerpt: relevantExcerpt(p.text, [...query.split(/\s+/), ...topic.split(/\s+/)], 6000) });
    }
  }
  ctx.repos.artifacts.save({ videoId, kind: 'research', agent: 'research', data: { queries, sources: out } });
  return out;
}
