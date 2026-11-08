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
import { editorProblems, spokenText } from './scriptwriter.ts';
import { countWords } from './base.ts';
import type { WebPage } from '../providers/web/web.ts';

export interface AutoVerifyInput { videoId: string; maxRounds?: number; /** Delete sentences of claims still unproven after the last round (default true). */ cutUnproven?: boolean }
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
    pages.push(...(await web.wikipedia(q, 'en', 3).catch(() => [])));
    // Also the pages the script was written from (after full pages, so an excerpt never hides a full page).
    for (const r of this.ctx.repos.artifacts.latest<{ sources: { url: string; excerpt: string }[] }>(videoId, 'research')?.data.sources ?? []) pages.push({ url: r.url, text: r.excerpt });
    pages.push(...(await web.wikipedia(c.claim.slice(0, 120), 'ar', 2).catch(() => [])));
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

  /**
   * After sentences were cut, let the model repair only the joins so the story still flows.
   * Accepted only if it adds no new numbers/years and barely changes the length — otherwise the cut script stays.
   */
  private async smoothTransitions(script: Script, videoId: string): Promise<Script> {
    const r = await this.ctx.providers.llm.generateJson({
      task: 'script.smooth',
      tier: 'writing',
      system: loadPrompt('script-fixer'),
      prompt: JSON.stringify({ instruction: 'Some sentences were removed from this script. Fix ONLY the transitions so every scene reads naturally (adjust connecting words, at most one short linking phrase per scene). Do NOT add any fact, number, date, name or claim. Return the complete script.', script }),
      schema: ScriptLLM,
      videoId,
      maxOutputTokens: 16000,
      vars: { previous: script },
    }).catch(() => undefined);
    if (!r) return script;
    const before = spokenText(script);
    const after = spokenText(r.data);
    const nums = new Set(claimNumbers(before));
    const newNumbers = claimNumbers(after).filter((n) => !nums.has(n));
    const ratio = countWords(after) / Math.max(1, countWords(before));
    if (newNumbers.length || ratio < 0.9 || ratio > 1.08) return script;
    return { ...script, ...r.data, format: script.format, wordCount: script.wordCount, estimatedDurationSec: script.estimatedDurationSec };
  }

  private async reEdit(videoId: string) {
    const script = this.ctx.repos.artifacts.latest<Script>(videoId, 'script')!.data;
    const topics = this.ctx.repos.artifacts.latest<{ topics?: { title: string; subject: string }[] }>(videoId, 'calendar_entry')?.data.topics;
    let problems = await editorProblems(this.ctx, { videoId, format: script.format }, script, topics);
    if (problems.length) {
      const r = await this.ctx.providers.llm.generateJson({
        task: 'script.reedit',
        tier: 'writing',
        system: loadPrompt('script-fixer'),
        prompt: JSON.stringify({ instruction: 'Fix ONLY these clarity problems (reword the first sentence of the affected scenes so it plainly names its subject; fix broken transitions). Do NOT add any fact, number, date, name or claim that is not already in the script. Return the complete script.', problems, script }),
        schema: ScriptLLM,
        videoId,
        maxOutputTokens: 16000,
        vars: { previous: script },
      }).catch(() => undefined);
      if (r) {
        const before = spokenText(script), after = spokenText({ ...r.data, format: script.format });
        const nums = new Set(claimNumbers(before));
        const ratio = countWords(after) / Math.max(1, countWords(before));
        if (!claimNumbers(after).some((n) => !nums.has(n)) && ratio > 0.85 && ratio < 1.2) {
          const fixed = { ...script, ...r.data, format: script.format, wordCount: countWords(after) };
          const left = await editorProblems(this.ctx, { videoId, format: script.format }, fixed, topics);
          if (left.length < problems.length) { this.ctx.repos.artifacts.save({ videoId, kind: 'script', agent: this.name, data: fixed }); problems = left; }
        }
      }
    }
    this.ctx.repos.artifacts.save({ videoId, kind: 'editor_review', agent: this.name, data: { problems } });
  }

  protected async execute(input: AutoVerifyInput): Promise<AutoVerifyOutput> {
    const maxRounds = input.maxRounds ?? 3;
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
    // Last resort: cut the exact sentence that carries each claim still unproven (if the cut is small).
    const bad = claims.filter((c) => c.status === 'unverified' || c.status === 'needs_review');
    if (bad.length && input.cutUnproven !== false) {
      const script = this.ctx.repos.artifacts.latest<Script>(input.videoId, 'script')!.data;
      const cut = cutClaimSentences(script, bad);
      const before = countWords(spokenText(script));
      if (cut.removed.length === bad.length && cut.removedWords <= before * 0.15) {
        const wpm = this.ctx.config.thresholds.script.arabicWordsPerMinute;
        const smooth = await this.smoothTransitions(cut.script, input.videoId);
        const wordCount = countWords(spokenText(smooth));
        this.ctx.repos.artifacts.save({ videoId: input.videoId, kind: 'script', agent: this.name, data: { ...smooth, wordCount, estimatedDurationSec: Math.round((wordCount / wpm) * 60) } });
        removed.push(...bad.map((c) => c.claim));
        claims = claims.filter((c) => !bad.includes(c));
      }
    }
    // Sentences were removed or rewritten: read it again as the viewer will hear it. A Short that now starts
    // mid-story ("the project…") or lost its subject gets its openings repaired with NO new facts; whatever the
    // editor still flags is saved and blocks automatic publishing.
    if (removed.length) await this.reEdit(input.videoId);
    return { claims, ...summarize(claims), rounds: round, removedClaims: removed };
  }
}

const norm = (t: string) => t.replace(/[\p{M}\u0640]/gu, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').toLowerCase();
const tokens = (t: string) => new Set(norm(t).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1));

/** Removes, per claim, the one sentence (in its scene, else anywhere) whose words best cover the claim. */
export function cutClaimSentences(script: Script, claims: Pick<CheckedClaim, 'claim' | 'sceneN'>[]) {
  const scenes = script.scenes.map((s) => ({ ...s, sentences: s.voiceover.split(/(?<=[.!؟?…])\s+/u) }));
  const removed: string[] = [];
  let removedWords = 0;
  for (const c of claims) {
    const ct = tokens(c.claim);
    const nums = claimNumbers(c.claim);
    let best: { si: number; i: number; score: number } | undefined;
    scenes.forEach((s, si) => s.sentences.forEach((sent, i) => {
      if (!sent) return;
      const st = tokens(sent);
      let hit = 0;
      for (const w of ct) if (st.has(w)) hit++;
      let score = ct.size ? hit / ct.size : 0;
      if (nums.length && nums.every((n) => sent.includes(n))) score += 0.3;
      if (c.sceneN && s.n === c.sceneN) score += 0.1;
      if (!best || score > best.score) best = { si, i, score };
    }));
    if (!best || best.score < 0.5) continue;
    const sent = scenes[best.si]!.sentences[best.i]!;
    if (scenes[best.si]!.sentences.filter(Boolean).length <= 1) continue; // never empty a scene
    removedWords += countWords(sent);
    scenes[best.si]!.sentences[best.i] = '';
    removed.push(c.claim);
  }
  const out: Script = { ...script, scenes: scenes.map(({ sentences, ...s }) => ({ ...s, voiceover: sentences.filter(Boolean).join(' ') })) };
  return { script: out, removed, removedWords };
}
