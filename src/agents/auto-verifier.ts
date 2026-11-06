/**
 * Automatic, strict fact verification (no human in the loop), free:
 *  - evidence = the page the model suggested + Wikipedia (en/ar), fetched and read for real;
 *  - an LLM judges each page, but its verdict only counts if its quote appears VERBATIM in the page;
 *  - facts need 1 independent source; statistics and quotes need 2 different sites, and numbers/years
 *    in the claim must appear in the quoted evidence;
 *  - whatever stays unverified is removed from the script (never replaced by new facts), then re-checked.
 * If anything is still unverified after the last round, the video stays blocked.
 */
import { Agent, type AgentContext } from './base.ts';
import { FactCheckerAgent, summarize } from './fact-checker.ts';
import { JudgeLLM, ScriptLLM, type CheckedClaim, type FactCheckReport, type Script } from './schemas.ts';
import { loadPrompt } from '../prompts.ts';
import { spokenText } from './scriptwriter.ts';
import { countWords } from './base.ts';
import type { WebPage } from '../providers/web/web.ts';

export interface AutoVerifyInput { videoId: string; maxRounds?: number }
export interface AutoVerifyOutput extends FactCheckReport { rounds: number; removedClaims: string[] }

const toLatinDigits = (s: string) => s.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
export function normalize(s: string): string {
  return toLatinDigits(s)
    .toLowerCase()
    .replace(/[ً-ٰٟ]/g, '') // Arabic diacritics
    .replace(/[“”«»„"]/g, '"').replace(/[‘’`]/g, "'").replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The judge's quote must be a real excerpt of the page (≥ 25 chars), not a paraphrase. */
export function quoteIsVerbatim(quote: string, pageText: string): boolean {
  const q = normalize(quote);
  return q.length >= 25 && normalize(pageText).includes(q);
}

/** Significant numbers in a claim (years, amounts ≥ 2 digits) that the evidence must contain. */
export function claimNumbers(claim: string): string[] {
  return [...new Set((toLatinDigits(claim).replace(/(\d),(\d)/g, '$1$2').match(/\d+(?:\.\d+)?/g) ?? []).filter((n) => n.replace('.', '').length >= 2))];
}
export function numbersCovered(claim: string, quote: string): boolean {
  const q = toLatinDigits(quote).replace(/(\d),(\d)/g, '$1$2');
  return claimNumbers(claim).every((n) => q.includes(n));
}

export const siteOf = (url: string) => {
  const h = new URL(url).hostname.replace(/^www\./, '');
  return h.endsWith('wikipedia.org') ? 'wikipedia.org' : h;
};

/** Keeps the paragraphs most related to the claim so the judge sees the relevant part of long pages. */
export function relevantExcerpt(text: string, keywords: string[], max = 8000): string {
  const kws = keywords.map((k) => normalize(k)).filter((k) => k.length >= 3);
  const paras = text.split(/\n+/).filter((p) => p.trim().length > 40);
  const scored = paras.map((p, i) => ({ p, i, s: kws.reduce((a, k) => a + (normalize(p).includes(k) ? 1 : 0), 0) }));
  const top = scored.filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  const chosen: typeof top = [];
  let len = 0;
  for (const x of top) { if (len + x.p.length > max) break; chosen.push(x); len += x.p.length; }
  return (chosen.length ? chosen.sort((a, b) => a.i - b.i).map((x) => x.p) : paras.slice(0, 20)).join('\n').slice(0, max);
}

export class AutoVerifierAgent extends Agent<AutoVerifyInput, AutoVerifyOutput> {
  readonly name = 'auto-verifier';
  readonly artifactKind = 'fact_check';
  constructor(ctx: AgentContext) { super(ctx); }

  private async evidenceFor(c: CheckedClaim, videoId: string): Promise<NonNullable<CheckedClaim['evidence']>> {
    const web = this.ctx.providers.web;
    const pages: WebPage[] = [];
    if (c.sourceUrl?.startsWith('https://')) pages.push(await web.fetchText(c.sourceUrl).catch(() => ({ url: c.sourceUrl!, text: '' })));
    const q = c.searchQuery || c.claim;
    pages.push(...(await web.wikipedia(q, 'en', 2).catch(() => [])));
    pages.push(...(await web.wikipedia(c.claim.slice(0, 120), 'ar', 1).catch(() => [])));
    const keywords = [...q.split(/\s+/), ...claimNumbers(c.claim)];
    const out: NonNullable<CheckedClaim['evidence']> = [];
    const seen = new Set<string>();
    for (const p of pages) {
      if (!p.text || seen.has(p.url)) continue;
      seen.add(p.url);
      const excerpt = relevantExcerpt(p.text, keywords);
      const j = await this.ctx.providers.llm.generateJson({
        task: 'factcheck.judge',
        tier: 'light',
        system: loadPrompt('fact-judge'),
        prompt: JSON.stringify({ claim: c.claim, sourceUrl: p.url, sourceText: excerpt }),
        schema: JudgeLLM,
        videoId,
        maxOutputTokens: 2000,
      }).catch(() => undefined);
      if (!j || j.data.verdict === 'not_found') continue;
      if (!quoteIsVerbatim(j.data.quote, excerpt)) continue; // hallucinated or paraphrased evidence never counts
      if (j.data.verdict === 'supported' && !numbersCovered(c.claim, j.data.quote)) continue;
      out.push({ url: p.url, quote: j.data.quote, verdict: j.data.verdict });
    }
    return out;
  }

  private async verifyAll(report: FactCheckReport, videoId: string): Promise<CheckedClaim[]> {
    const claims: CheckedClaim[] = [];
    for (const c of report.claims) {
      // Opinions/predictions need no source; claims a human already verified are kept.
      if (c.status === 'not_applicable' || (c.status === 'verified' && c.reasons.some((r) => r.startsWith('Verified by')))) { claims.push(c); continue; }
      const ev = await this.evidenceFor(c, videoId);
      const supported = ev.filter((e) => e.verdict === 'supported');
      const sites = new Set(supported.map((e) => siteOf(e.url)));
      const needed = c.type === 'statistic' || c.type === 'quote' ? 2 : 1;
      if (sites.size >= needed) {
        claims.push({ ...c, sourceUrl: supported[0]!.url, sourceTitle: c.sourceTitle, status: 'verified', humanReviewRequired: false, evidence: ev, reasons: [`Auto-verified: ${sites.size} independent source(s) with verbatim quotes`] });
      } else {
        const contradicted = ev.some((e) => e.verdict === 'contradicted');
        claims.push({ ...c, status: 'unverified', humanReviewRequired: true, evidence: ev, contradicted, reasons: [contradicted ? 'Contradicted by a source' : `Only ${sites.size}/${needed} independent source(s) confirm it`] });
      }
    }
    return claims;
  }

  protected async execute(input: AutoVerifyInput): Promise<AutoVerifyOutput> {
    const maxRounds = input.maxRounds ?? 2;
    const removed: string[] = [];
    let report = this.ctx.repos.artifacts.latest<FactCheckReport>(input.videoId, 'fact_check')!.data;
    let claims: CheckedClaim[] = [];
    let round = 0;
    for (; round <= maxRounds; round++) {
      claims = await this.verifyAll(report, input.videoId);
      const bad = claims.filter((c) => c.status === 'unverified' || c.status === 'needs_review');
      if (!bad.length || round === maxRounds) break;

      // Remove/soften what could not be proven, then extract claims again from the new script.
      const script = this.ctx.repos.artifacts.latest<Script>(input.videoId, 'script')!.data;
      const fixed = await this.ctx.providers.llm.generateJson({
        task: 'script.fixclaims',
        tier: 'writing',
        system: loadPrompt('script-fixer'),
        prompt: JSON.stringify({ unverifiedClaims: bad.map((c) => ({ claim: c.claim, scene: c.sceneN })), script }),
        schema: ScriptLLM,
        videoId: input.videoId,
        maxOutputTokens: 16000,
        vars: { previous: script },
      });
      const wpm = this.ctx.config.thresholds.script.arabicWordsPerMinute;
      const wordCount = countWords(spokenText(fixed.data));
      this.ctx.repos.artifacts.save({ videoId: input.videoId, kind: 'script', agent: this.name, data: { ...fixed.data, wordCount, estimatedDurationSec: Math.round((wordCount / wpm) * 60), format: script.format } });
      removed.push(...bad.map((c) => c.claim));
      report = await new FactCheckerAgent(this.ctx).run({ videoId: input.videoId, script: this.ctx.repos.artifacts.latest<Script>(input.videoId, 'script')!.data });
    }
    return { claims, ...summarize(claims), rounds: round, removedClaims: removed };
  }
}
