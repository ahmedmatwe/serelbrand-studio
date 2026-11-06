import type { AgentContext } from '../agents/base.ts';
import type { ComplianceReport } from '../agents/compliance.ts';
import { summarize } from '../agents/fact-checker.ts';
import type { QualityReport } from '../agents/quality.ts';
import type { FactCheckReport, Script, SeoPackage } from '../agents/schemas.ts';
import type { ThumbnailOutput } from '../agents/thumbnail.ts';
import { PublishBlockedError, StudioError, ValidationError } from '../core/errors.ts';
import type { Approval } from '../database/repositories.ts';
import { buildPrePublicationReport, renderApprovalMessage, type PrePublicationReport } from '../reports/prepublication.ts';
import { proposePublishTime } from './schedule.ts';

/** Artifacts whose change invalidates a pending approval. */
const GATED_KINDS = ['script', 'fact_check', 'blueprint', 'thumbnails', 'seo_package', 'compliance_report', 'quality_report'];

function need<T>(ctx: AgentContext, videoId: string, kind: string) {
  const a = ctx.repos.artifacts.latest<T>(videoId, kind);
  if (!a) throw new StudioError('MISSING_INPUT', `Video ${videoId} has no "${kind}" — run the pipeline first`);
  return a;
}

export function buildReport(ctx: AgentContext, videoId: string): PrePublicationReport {
  const format = ctx.repos.videos.get(videoId)?.format ?? 'long';
  const when = proposePublishTime(ctx.repos.knowledge, { minSamples: ctx.config.thresholds.analytics.minVideosForStrategicConclusion, format });
  return buildPrePublicationReport({
    videoId,
    script: need<Script>(ctx, videoId, 'script').data,
    seo: need<SeoPackage>(ctx, videoId, 'seo_package').data,
    thumbnails: need<ThumbnailOutput>(ctx, videoId, 'thumbnails').data,
    factCheck: need<FactCheckReport>(ctx, videoId, 'fact_check').data,
    compliance: need<ComplianceReport>(ctx, videoId, 'compliance_report').data,
    quality: need<QualityReport>(ctx, videoId, 'quality_report').data,
    thresholds: ctx.config.thresholds,
    estimatedCostUsd: ctx.cost.forVideo(videoId),
    proposedPublishAt: when.at,
    publishTimeRationale: when.rationale,
  });
}

/**
 * Builds the pre-publication report and, unless hard-blocked, opens an approval request.
 * Blocked videos never get an approval row — they must be fixed and re-reviewed.
 */
export function requestApproval(ctx: AgentContext, videoId: string): { report: PrePublicationReport; approval: Approval | null; message: string } {
  const report = buildReport(ctx, videoId);
  ctx.repos.artifacts.save({ videoId, kind: 'prepublication_report', agent: 'orchestrator', data: report });
  if (report.recommendation === 'blocked' || report.recommendation === 'needs_fixes') {
    ctx.audit.record({ actor: 'orchestrator', action: 'approval.not_requested', target: videoId, details: { recommendation: report.recommendation, blockers: report.hardBlockers } });
    return { report, approval: null, message: renderApprovalMessage(report, '—') };
  }
  const approval = ctx.repos.approvals.request(videoId, 'private', report);
  ctx.repos.videos.update(videoId, { status: 'awaiting_approval' });
  ctx.audit.record({ actor: 'orchestrator', action: 'approval.requested', target: videoId, details: { approvalId: approval.id } });
  return { report, approval, message: renderApprovalMessage(report, approval.id) };
}

export interface ApproveOptions {
  by: string;
  visibility?: 'private' | 'unlisted' | 'public';
  /** ISO time to go public automatically (YouTube scheduling == public publishing). */
  publishAt?: string;
  /** Required when the report says approve_with_caution. */
  acceptRisks?: boolean;
  note?: string;
}

export function approve(ctx: AgentContext, approvalId: string, o: ApproveOptions): Approval {
  const a = ctx.repos.approvals.get(approvalId);
  if (!a) throw new StudioError('NOT_FOUND', `Approval ${approvalId} not found`);
  if (a.status !== 'pending') throw new PublishBlockedError(`Approval ${approvalId} is already ${a.status}`);
  const report = JSON.parse(a.report) as PrePublicationReport;

  // Stale check: any gated artifact changed after the report => re-review required.
  const stale = GATED_KINDS.filter((k) => (ctx.repos.artifacts.latest(a.video_id, k)?.created_at ?? '') > report.generatedAt);
  if (stale.length) throw new PublishBlockedError(`Content changed after the report (${stale.join(', ')}). Run "review" again.`);

  const visibility = o.visibility ?? 'private';
  const goesPublic = visibility === 'public' || Boolean(o.publishAt);
  if (goesPublic && !ctx.config.env.ALLOW_PUBLIC_PUBLISHING)
    throw new PublishBlockedError('Public publishing/scheduling is disabled during the testing phase (ALLOW_PUBLIC_PUBLISHING=false). Approve as private or unlisted.');
  if (o.publishAt && Number.isNaN(Date.parse(o.publishAt))) throw new ValidationError(`Invalid publishAt "${o.publishAt}"`);
  if (report.recommendation === 'approve_with_caution' && !(o.acceptRisks && o.note?.trim()))
    throw new PublishBlockedError('This video has warnings. Approve with --accept-risks --note "<why it is OK>"');

  const finalVisibility = o.publishAt ? 'private' : visibility; // YouTube: scheduled videos are uploaded as private + publishAt
  ctx.repos.approvals.decide(approvalId, 'approved', o.by, o.note, o.publishAt ? `scheduled:${o.publishAt}` : finalVisibility);
  ctx.repos.videos.update(a.video_id, { status: 'approved', visibility: finalVisibility, scheduled_at: o.publishAt ?? null });
  ctx.audit.record({ actor: 'human', action: 'approval.approved', target: a.video_id, details: { approvalId, by: o.by, visibility: finalVisibility, publishAt: o.publishAt, note: o.note } });
  return ctx.repos.approvals.get(approvalId)!;
}

export function reject(ctx: AgentContext, approvalId: string, by: string, note: string) {
  const a = ctx.repos.approvals.get(approvalId);
  if (!a) throw new StudioError('NOT_FOUND', `Approval ${approvalId} not found`);
  if (!ctx.repos.approvals.decide(approvalId, 'rejected', by, note)) throw new PublishBlockedError(`Approval ${approvalId} is already ${a.status}`);
  ctx.repos.videos.update(a.video_id, { status: 'rejected' });
  ctx.audit.record({ actor: 'human', action: 'approval.rejected', target: a.video_id, details: { approvalId, by, note } });
}

/** A human confirms a claim against a real https source. Creates a new fact-check version. */
export function verifyClaim(ctx: AgentContext, videoId: string, claimIndex: number, o: { url?: string; title?: string; date?: string; by: string }) {
  const fc = need<FactCheckReport>(ctx, videoId, 'fact_check').data;
  const c = fc.claims[claimIndex];
  if (!c) throw new ValidationError(`No claim #${claimIndex} (0..${fc.claims.length - 1})`);
  // Without --url the human confirms the model-suggested source after opening it.
  const url = o.url ?? c.sourceUrl ?? '';
  if (!/^https:\/\/[^\s]+\.[^\s]+/.test(url)) throw new ValidationError('Source must be a real https:// URL (pass --url)');
  const claims = fc.claims.map((x, i) =>
    i === claimIndex
      ? { ...x, sourceUrl: url, sourceTitle: o.title ?? x.sourceTitle, sourceDate: o.date ?? x.sourceDate, status: 'verified' as const, humanReviewRequired: false, reasons: [`Verified by ${o.by}`] }
      : x,
  );
  const next: FactCheckReport = { claims, ...summarize(claims) };
  ctx.repos.artifacts.save({ videoId, kind: 'fact_check', agent: `human:${o.by}`, data: next });
  ctx.audit.record({ actor: 'human', action: 'factcheck.verified', target: videoId, details: { claimIndex, url, by: o.by, acceptedSuggestion: !o.url } });
  return next;
}
