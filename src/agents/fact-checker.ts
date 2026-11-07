import { Agent } from './base.ts';
import { FactCheckLLM, type CheckedClaim, type FactCheckReport, type Script } from './schemas.ts';
import { loadPrompt } from '../prompts.ts';

export interface FactCheckInput { videoId: string; script: Script; now?: Date }

const MAX_STAT_AGE_YEARS = 3;

/** Deterministic post-processing: the model proposes, these rules decide. */
export function evaluateClaim(c: FactCheckLLMClaim, now = new Date(), opts: { modelSourced?: boolean } = {}): CheckedClaim {
  // Sources proposed by a language model can be hallucinated, so they are never auto-verified.
  const modelSourced = opts.modelSourced ?? true;
  const reasons: string[] = [];
  // A "opinion" that carries a number, a year or a percentage is a factual claim in disguise: check it.
  if ((c.type === 'opinion' || c.type === 'prediction') && /[0-9٠-٩]|٪|%/.test(c.claim)) c = { ...c, type: 'fact' };
  if (c.type === 'opinion' || c.type === 'prediction') {
    return { ...c, status: 'not_applicable', humanReviewRequired: false, reasons: [`${c.type}: must be phrased as such in the script`] };
  }
  let status: CheckedClaim['status'] = 'verified';
  if (!c.sourceUrl) {
    status = 'unverified';
    reasons.push('No source');
  } else if (!/^https:\/\//i.test(c.sourceUrl)) {
    status = 'needs_review';
    reasons.push(c.sourceUrl.startsWith('mock://') ? 'Mock source (dry-run) — real source required' : 'Source is not an https URL');
  } else if (modelSourced) {
    status = 'needs_review';
    reasons.push('Model-suggested source — a human must open it and confirm it supports the claim (verify command)');
  }
  if (c.confidence !== 'high' && status === 'verified') {
    status = 'needs_review';
    reasons.push(`Confidence ${c.confidence}`);
  }
  if (c.type === 'statistic' && c.sourceDate) {
    const ageYears = (now.getTime() - new Date(c.sourceDate).getTime()) / (365.25 * 86_400_000);
    if (ageYears > MAX_STAT_AGE_YEARS) {
      if (status === 'verified') status = 'needs_review';
      reasons.push(`Statistic source is ${ageYears.toFixed(1)} years old`);
    }
  }
  if (c.type === 'quote' && status !== 'verified') reasons.push('Quotes must be verified verbatim from a primary source');
  return { ...c, status, humanReviewRequired: status !== 'verified', reasons };
}
type FactCheckLLMClaim = ReturnType<typeof FactCheckLLM.parse>['claims'][number];

export function summarize(claims: CheckedClaim[]): Pick<FactCheckReport, 'overall' | 'summary'> {
  const n = (s: CheckedClaim['status']) => claims.filter((c) => c.status === s).length;
  const overall: FactCheckReport['overall'] = n('unverified') > 0 ? 'blocked' : n('needs_review') > 0 ? 'needs_review' : 'verified';
  return {
    overall,
    summary: `${claims.length} ادعاء: ${n('verified')} مؤكد، ${n('needs_review')} يحتاج مراجعة، ${n('unverified')} بدون مصدر، ${n('not_applicable')} رأي/توقع.`,
  };
}

export class FactCheckerAgent extends Agent<FactCheckInput, FactCheckReport> {
  readonly name = 'fact-checker';
  readonly artifactKind = 'fact_check';

  protected async execute(input: FactCheckInput): Promise<FactCheckReport> {
    const res = await this.ctx.providers.llm.generateJson({
      task: 'factcheck.claims',
      tier: 'writing',
      system: loadPrompt('fact-checker'),
      prompt: JSON.stringify({ scenes: input.script.scenes.map((s) => ({ n: s.n, text: s.voiceover })), opening: input.script.opening, ending: input.script.ending }),
      schema: FactCheckLLM,
      videoId: input.videoId,
    });
    const claims = res.data.claims.map((c) => evaluateClaim(c, input.now));
    const report = { claims, ...summarize(claims) };
    this.ctx.repos.videos.update(input.videoId, { status: 'fact_checked' });
    return report;
  }
}
