import { Agent, clamp, countWords } from './base.ts';
import type { Blueprint, Script, SeoPackage, ThumbnailConcept } from './schemas.ts';
import type { ComplianceReport } from './compliance.ts';
import { duplicateSentenceRatio, titleSupport } from './compliance.ts';
import { spokenText } from './scriptwriter.ts';
import type { Thresholds } from '../core/config.ts';

export interface QualityInput {
  videoId: string;
  script: Script;
  blueprint: Blueprint;
  thumbnails: ThumbnailConcept[];
  seo: SeoPackage;
  compliance: ComplianceReport;
  /** Filled after rendering (phase 4). Until then these criteria are reported as pending. */
  render?: { audioScore: number; visualScore: number; subtitleAccuracy: number };
}

export interface QualityCriterion { score: number | null; weight: number; note: string }
export interface QualityReport {
  score: number;
  criteria: Record<string, QualityCriterion>;
  weaknesses: string[];
  fixes: string[];
  pendingRender: boolean;
  method: string;
}

export function scoreQuality(i: QualityInput, t: Thresholds): QualityReport {
  const text = spokenText(i.script);
  const sentences = text.split(/[.!؟?\n]+/).map((s) => s.trim()).filter(Boolean);
  const avgSentence = sentences.reduce((a, s) => a + countWords(s), 0) / Math.max(1, sentences.length);
  // Long video: whole duration. Shorts pack: every scene is its own Short, so judge the longest scene.
  const dur = i.script.format === 'long' ? i.script.estimatedDurationSec : Math.max(...i.blueprint.scenes.map((s) => s.durationSec));
  const [minSec, maxSec] = i.script.format === 'long' ? [t.script.longForm.minMinutes * 60, t.script.longForm.maxMinutes * 60] : [15, t.script.short.maxSeconds];
  const durationFit = dur >= minSec && dur <= maxSec ? 100 : clamp(100 - (Math.abs(dur - (dur < minSec ? minSec : maxSec)) / minSec) * 150);

  const firstHook = i.script.hooks[0] ?? '';
  const hook = clamp(
    (i.script.hooks.length >= t.packaging.minHooks ? 40 : 15) +
      (countWords(firstHook) <= 25 ? 25 : 10) +
      (/[؟?]|\d|[٠-٩]/.test(firstHook) ? 20 : 5) +
      (i.script.scenes[0]?.curiosityGap ? 15 : 0) + (i.script.scenes[0]?.onScreenText?.trim() ? 10 : 0),
  );
  const gaps = i.script.scenes.filter((s) => s.curiosityGap).length;
  const avgSceneSec = i.blueprint.totalDurationSec / Math.max(1, i.blueprint.scenes.length);
  const minScenes = i.script.format === 'long' ? 5 : 3;
  const structure = clamp(
    (i.script.scenes.length >= minScenes ? 40 : 20) + (i.script.opening ? 15 : 0) + (i.script.cta ? 15 : 0) + (i.script.ending ? 15 : 0) + (i.script.scenes.every((s) => s.transition) ? 15 : 0),
  );
  const best = i.thumbnails.filter((x) => x.valid).sort((a, b) => a.textWordCount - b.textWordCount)[0];
  const support = titleSupport(i.seo.primaryTitle, text);

  const criteria: Record<string, QualityCriterion> = {
    originality: { score: clamp(100 - duplicateSentenceRatio(text) * 300 - (i.compliance.issues.some((x) => x.check.startsWith('originality.')) ? 20 : 0)), weight: 10, note: 'Duplicate-sentence ratio + originality flags' },
    viewerValue: { score: durationFit, weight: 8, note: `Duration ${Math.round(dur / 60)}m vs target ${minSec / 60}–${maxSec / 60}m` },
    hookStrength: { score: hook, weight: 10, note: 'Hook count, length, question/number, opening curiosity gap' },
    clarity: { score: clamp(avgSentence <= 20 ? 95 : 95 - (avgSentence - 20) * 4), weight: 7, note: `Avg sentence ${avgSentence.toFixed(1)} words` },
    storyStructure: { score: structure, weight: 8, note: 'Opening, scenes, transitions, CTA, ending' },
    retentionPotential: { score: clamp(40 + Math.min(gaps, 4) * 10 + (avgSceneSec >= 8 && avgSceneSec <= 60 ? 20 : 0)), weight: 10, note: `${gaps} curiosity gaps, ~${Math.round(avgSceneSec)}s per scene` },
    audioQuality: { score: i.render?.audioScore ?? null, weight: 6, note: i.render ? 'Measured after render' : 'Pending render' },
    visualQuality: { score: i.render?.visualScore ?? null, weight: 6, note: i.render ? 'Measured after render' : 'Pending render' },
    subtitleAccuracy: { score: i.render?.subtitleAccuracy ?? null, weight: 5, note: i.render ? 'Measured after render' : 'Pending render' },
    thumbnailReadability: { score: best ? clamp(100 - Math.max(0, best.textWordCount - 3) * 10) : 0, weight: 7, note: best ? `Best concept: "${best.text}"` : 'No valid concept' },
    titleAccuracy: { score: clamp(Math.round(support * 100) + 10), weight: 8, note: `${Math.round(support * 100)}% of title keywords covered` },
    copyrightSafety: { score: i.compliance.copyrightStatus === 'clear' ? 100 : i.compliance.copyrightStatus === 'needs_review' ? 60 : 0, weight: 6, note: i.compliance.copyrightStatus },
    policyCompliance: { score: i.compliance.score, weight: 5, note: i.compliance.label },
    monetizationSuitability: { score: { low: 95, medium: 70, high: 30 }[i.compliance.monetizationRisk], weight: 4, note: `Monetization risk ${i.compliance.monetizationRisk}` },
  };

  const measured = Object.values(criteria).filter((c) => c.score !== null);
  const totalW = measured.reduce((a, c) => a + c.weight, 0);
  const baseScore = measured.length ? Math.round(measured.reduce((a, c) => a + (c.score as number) * c.weight, 0) / totalW) : 0;
  // Render gates are non-negotiable: a polished package must not pass while the delivered media is broken.
  const renderPenalty = i.render
    ? (i.render.audioScore < 80 ? 20 : 0) + (i.render.visualScore < 75 ? 20 : 0) + (i.render.subtitleAccuracy < 95 ? 20 : 0)
    : 0;
  const score = clamp(baseScore - renderPenalty);

  const FIX: Record<string, string> = {
    originality: 'Rewrite repeated passages and add original analysis or graphics',
    viewerValue: 'Adjust script length to the target duration with substance, not filler',
    hookStrength: 'Shorten the first hook (<15 s), open with a concrete question or number',
    clarity: 'Split long sentences',
    storyStructure: 'Complete missing sections (opening/CTA/ending/transitions)',
    retentionPotential: 'Add 2–4 curiosity gaps that are paid off later; keep scenes 8–60 s',
    thumbnailReadability: 'Use 2–3 bold words on the thumbnail',
    titleAccuracy: 'Make the title describe what the video actually covers',
    copyrightSafety: 'Resolve copyright issues in the compliance report',
    policyCompliance: 'Resolve compliance issues',
    monetizationSuitability: 'Reduce advertiser-unfriendly elements',
  };
  const weak = Object.entries(criteria).filter(([, c]) => c.score !== null && c.score < 70);
  return {
    score,
    criteria,
    weaknesses: weak.map(([k, c]) => `${k}: ${c.score} — ${c.note}`),
    fixes: weak.map(([k]) => FIX[k] ?? `Improve ${k}`),
    pendingRender: !i.render,
    method: 'Rule-based gates plus measured render gates. Audio, visual continuity, and subtitle accuracy failures reduce the publish score; viral performance is learned from channel analytics, never promised.',
  };
}

export class QualityAgent extends Agent<QualityInput, QualityReport> {
  readonly name = 'quality';
  readonly artifactKind = 'quality_report';
  protected async execute(input: QualityInput) {
    const r = scoreQuality(input, this.ctx.config.thresholds);
    this.ctx.repos.videos.update(input.videoId, { status: 'reviewed' });
    return r;
  }
}
