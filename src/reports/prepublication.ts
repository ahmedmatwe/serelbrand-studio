import type { ComplianceReport } from '../agents/compliance.ts';
import type { QualityReport } from '../agents/quality.ts';
import type { FactCheckReport, Script, SeoPackage } from '../agents/schemas.ts';
import type { ThumbnailOutput } from '../agents/thumbnail.ts';
import type { Thresholds } from '../core/config.ts';

export type Recommendation = 'ready_for_approval' | 'approve_with_caution' | 'needs_fixes' | 'blocked';

export interface PrePublicationReport {
  videoId: string;
  title: string;
  durationSec: number;
  thumbnail: { text: string; mainVisual: string } | null;
  qualityScore: number;
  complianceScore: number;
  complianceLabel: ComplianceReport['label'];
  copyrightStatus: ComplianceReport['copyrightStatus'];
  factCheckStatus: FactCheckReport['overall'];
  monetizationRisk: ComplianceReport['monetizationRisk'];
  requiresSyntheticDisclosure: boolean;
  hardBlockers: string[];
  warnings: string[];
  weaknesses: string[];
  requiredFixes: string[];
  estimatedCostUsd: number;
  proposedPublishAt: string;
  publishTimeRationale: string;
  recommendation: Recommendation;
  recommendationText: string;
  generatedAt: string;
}

export function buildPrePublicationReport(i: {
  videoId: string;
  script: Script;
  seo: SeoPackage;
  thumbnails: ThumbnailOutput;
  factCheck: FactCheckReport;
  compliance: ComplianceReport;
  quality: QualityReport;
  thresholds: Thresholds;
  estimatedCostUsd: number;
  proposedPublishAt: string;
  publishTimeRationale: string;
}): PrePublicationReport {
  const t = i.thresholds;
  const hardBlockers = [...i.compliance.blockers];
  if (i.quality.pendingRender) hardBlockers.push('render: no measured video/audio/caption quality');
  for (const [name, minimum] of [['audioQuality', 80], ['visualQuality', 75], ['subtitleAccuracy', 95]] as const) {
    const score = i.quality.criteria[name]?.score;
    if (score === null || score === undefined || score < minimum) hardBlockers.push(`${name}: ${score ?? 'missing'} < ${minimum}`);
  }
  if (i.quality.score < i.thresholds.quality.minScoreToPublish) hardBlockers.push(`quality: ${i.quality.score} < ${i.thresholds.quality.minScoreToPublish}`);
  if (i.factCheck.overall === 'blocked' && !hardBlockers.some((b) => b.startsWith('facts.'))) hardBlockers.push('facts: unverified claims');

  const warnings: string[] = [];
  if (i.quality.score < t.quality.minScoreToPublish) warnings.push(`Quality score ${i.quality.score} < recommended ${t.quality.minScoreToPublish}`);
  // A high average must not hide one very weak criterion (e.g. a 2-minute "long" video).
  for (const [k, c] of Object.entries(i.quality.criteria)) if (c.score !== null && c.score < 40) warnings.push(`Quality: weak ${k} (${c.score}) — ${c.note}`);
  if (i.quality.pendingRender) warnings.push('Audio/visual/subtitle quality not measured yet (no render)');
  if (i.compliance.label === 'Needs human review') warnings.push('Compliance: needs human review');
  if (i.compliance.requiresSyntheticDisclosure) warnings.push('Enable YouTube "altered or synthetic content" disclosure on upload');

  const recommendation: Recommendation = hardBlockers.length
    ? 'blocked'
    : i.quality.score < t.quality.minScoreToPublish - 15
      ? 'needs_fixes'
      : warnings.some((w) => w.startsWith('Quality') || w.startsWith('Compliance'))
        ? 'approve_with_caution'
        : 'ready_for_approval';

  const TEXT: Record<Recommendation, string> = {
    blocked: '⛔ ممنوع النشر: لازم تتحل المشاكل الأساسية الأول.',
    needs_fixes: '🛠️ يحتاج تعديلات قبل طلب الموافقة.',
    approve_with_caution: '⚠️ ممكن يتوافق عليه بعد مراجعتك للتحذيرات.',
    ready_for_approval: '✅ جاهز لموافقتك.',
  };

  const best = i.thumbnails.concepts[i.thumbnails.recommendedIndex];
  return {
    videoId: i.videoId,
    title: i.seo.primaryTitle,
    durationSec: i.script.estimatedDurationSec,
    thumbnail: best ? { text: best.text, mainVisual: best.mainVisual } : null,
    qualityScore: i.quality.score,
    complianceScore: i.compliance.score,
    complianceLabel: i.compliance.label,
    copyrightStatus: i.compliance.copyrightStatus,
    factCheckStatus: i.factCheck.overall,
    monetizationRisk: i.compliance.monetizationRisk,
    requiresSyntheticDisclosure: i.compliance.requiresSyntheticDisclosure,
    hardBlockers,
    warnings,
    weaknesses: i.quality.weaknesses,
    requiredFixes: [...i.compliance.issues.filter((x) => x.severity !== 'low').map((x) => x.fix), ...i.quality.fixes],
    estimatedCostUsd: Number(i.estimatedCostUsd.toFixed(4)),
    proposedPublishAt: i.proposedPublishAt,
    publishTimeRationale: i.publishTimeRationale,
    recommendation,
    recommendationText: TEXT[recommendation],
    generatedAt: new Date().toISOString(),
  };
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** Plain-text approval message (CLI now; Telegram/email later). */
export function renderApprovalMessage(r: PrePublicationReport, approvalId: string): string {
  return [
    `📺 طلب موافقة — ${r.title}`,
    `المدة: ${mmss(r.durationSec)} · التكلفة التقديرية: $${r.estimatedCostUsd}`,
    `الصورة المصغّرة: ${r.thumbnail ? `"${r.thumbnail.text}" — ${r.thumbnail.mainVisual}` : 'لا يوجد مفهوم صالح'}`,
    `الجودة: ${r.qualityScore}/100 · الامتثال: ${r.complianceScore}/100 (${r.complianceLabel})`,
    `الحقوق: ${r.copyrightStatus} · تدقيق الحقائق: ${r.factCheckStatus} · مخاطر الربح: ${r.monetizationRisk}`,
    `موعد مقترح: ${r.proposedPublishAt} (${r.publishTimeRationale})`,
    r.hardBlockers.length ? `\n⛔ موانع:\n- ${r.hardBlockers.join('\n- ')}` : '',
    r.warnings.length ? `\n⚠️ تحذيرات:\n- ${r.warnings.join('\n- ')}` : '',
    `\n${r.recommendationText}`,
    r.recommendation === 'blocked'
      ? ''
      : `\nللموافقة (رفع خاص private):  npm run cli -- approve ${approvalId}\nللرفض:                        npm run cli -- reject ${approvalId} --note "السبب"`,
  ].filter(Boolean).join('\n');
}
