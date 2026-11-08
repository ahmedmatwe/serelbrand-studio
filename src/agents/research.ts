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

export async function researchTopic(ctx: AgentContext, videoId: string, topic: string, angle = '', subject?: string, urls: string[] = []): Promise<ResearchSource[]> {
  if (ctx.providers.web.name === 'mock-web') return []; // offline runs: no sources to fetch
  const q = await ctx.providers.llm.generateJson({
    task: 'research.queries',
    tier: 'light',
    system: 'You find sources for a short factual video. Give 2–4 short ENGLISH Wikipedia search queries (article titles work best): the company, product, feature, technology, person or event at the heart of the topic. JSON only.',
    prompt: JSON.stringify({ topic, angle }),
    schema: QueriesLLM,
    videoId,
    maxOutputTokens: 1000,
  }).catch(() => undefined);
  // The planned subject is an exact Wikipedia title: always search it first, so a failed query step never
  // leaves a topic without sources.
  const queries = [...new Set([subject?.trim(), ...(q?.data.queries ?? [])].filter((x): x is string => Boolean(x)))];
  const seen = new Set<string>();
  const out: ResearchSource[] = [];
  // Official pages first (e.g. support.apple.com for a hidden iPhone feature): the most exact source there is.
  for (const u of urls.filter((x) => x.startsWith('https://'))) {
    const p = await ctx.providers.web.fetchText(u).catch(() => undefined);
    if (p?.text && p.text.length > 300 && !seen.has(p.url)) { seen.add(p.url); out.push({ url: p.url, title: p.title, excerpt: p.text.slice(0, 6000) }); }
  }
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
