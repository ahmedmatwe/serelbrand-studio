import { Agent } from '../agents/base.ts';
import type { ComplianceReport } from '../agents/compliance.ts';
import type { FactCheckReport, SeoPackage } from '../agents/schemas.ts';
import { composeDescription } from '../agents/seo.ts';
import { PublishBlockedError } from '../core/errors.ts';
import { withRetry } from '../core/retry.ts';
import type { UploadResult, Visibility } from '../providers/media.ts';
import type { PrePublicationReport } from '../reports/prepublication.ts';
import { currentSlots, nextSlots } from './schedule.ts';

export interface PublishInput { videoId: string }
export interface PublishLog extends UploadResult { videoId: string; provider: string; dryRun: boolean; uploadedAt: string; attempts: number; shorts: { youtubeVideoId: string; title: string; publishAt?: string }[] }

/**
 * Uploads an approved video. Re-checks every gate at upload time (defence in depth):
 * approval exists, report has no blockers, public/scheduled needs ALLOW_PUBLIC_PUBLISHING, render exists when live.
 */
export class PublisherAgent extends Agent<PublishInput, PublishLog> {
  readonly name = 'publisher';
  readonly artifactKind = 'publish_log';

  protected async execute({ videoId }: PublishInput): Promise<PublishLog> {
    const video = this.ctx.repos.videos.get(videoId);
    if (!video) throw new PublishBlockedError(`Video ${videoId} not found`);
    if (video.youtube_video_id) throw new PublishBlockedError(`Video already uploaded as ${video.youtube_video_id}`);

    const approval = this.ctx.repos.approvals.latestForVideo(videoId);
    if (!approval || approval.status !== 'approved') throw new PublishBlockedError('No human approval for this video');
    const report = JSON.parse(approval.report) as PrePublicationReport;
    if (report.hardBlockers.length) throw new PublishBlockedError(`Report has blockers: ${report.hardBlockers.join('; ')}`);

    const scheduled = approval.requested_visibility.startsWith('scheduled:') ? approval.requested_visibility.slice('scheduled:'.length) : undefined;
    const visibility = (scheduled ? 'private' : approval.requested_visibility) as Visibility;
    const { env } = this.ctx.config;
    if ((visibility === 'public' || scheduled) && !env.ALLOW_PUBLIC_PUBLISHING) throw new PublishBlockedError('Public publishing is disabled (ALLOW_PUBLIC_PUBLISHING=false)');

    const render = this.ctx.repos.artifacts.latest<{ videoPath: string; thumbnailPath?: string; captionsPath?: string; shorts?: { path: string; title: string }[]; packOnly?: boolean; assets?: { source: string; attribution?: string; pageUrl?: string }[] }>(videoId, 'render');
    if (!render && !env.DRY_RUN) throw new PublishBlockedError('No rendered video file yet (rendering arrives in phase 4)');

    const seo = this.ctx.repos.artifacts.latest<SeoPackage>(videoId, 'seo_package')!.data;
    const compliance = this.ctx.repos.artifacts.latest<ComplianceReport>(videoId, 'compliance_report')!.data;
    const yt = this.ctx.providers.youtube;
    // Shorts pack: the first Short is the "main" upload; the others follow 4 h apart.
    const pack = Boolean(render?.data.packOnly && render.data.shorts?.length);
    const shortTitle = (t: string) => `${t.replace(/#\S+/g, '').trim().slice(0, 88)} #Shorts`;
    const description = composeDescription(seo, this.ctx.repos.artifacts.latest<FactCheckReport>(videoId, 'fact_check')?.data, render?.data.assets);
    let attempts = 0;
    const res = await withRetry(
      () => {
        attempts++;
        return yt.upload({
          videoPath: pack ? render!.data.shorts![0]!.path : render?.data.videoPath ?? `mock://render/${videoId}.mp4`,
          thumbnailPath: pack ? undefined : render?.data.thumbnailPath || undefined,
          captionsPath: pack ? undefined : render?.data.captionsPath || undefined,
          title: pack ? shortTitle(render!.data.shorts![0]!.title) : seo.primaryTitle,
          description: pack ? `${description}\n#Shorts` : description,
          tags: seo.tags,
          visibility,
          publishAt: scheduled,
          containsSyntheticMedia: compliance.requiresSyntheticDisclosure,
          defaultLanguage: this.ctx.config.channel.language,
        });
      },
      { attempts: this.ctx.config.thresholds.jobs.maxAttempts, baseDelayMs: this.ctx.config.thresholds.jobs.baseBackoffMs },
    );
    this.ctx.cost.record({ provider: yt.name, operation: 'videos.insert', videoId, units: 1600, unit: 'requests', usd: 0 });
    this.ctx.repos.videos.update(videoId, { status: scheduled || visibility === 'public' ? 'published' : 'uploaded', youtube_video_id: res.youtubeVideoId, visibility, scheduled_at: scheduled ?? null });
    this.ctx.audit.record({ actor: this.name, action: 'video.uploaded', target: videoId, details: { youtubeVideoId: res.youtubeVideoId, visibility, scheduled, dryRun: env.DRY_RUN } });
    // Shorts cut from this video: separate uploads, same visibility, linking back to the full story.
    const shorts: PublishLog['shorts'] = [];
    // Scheduled Shorts go out at the next Shorts slots after the main publish time (learned or default hours).
    const restShorts = (render?.data.shorts ?? []).slice(pack ? 1 : 0);
    const shortTimes = scheduled ? nextSlots(currentSlots(this.ctx.repos.knowledge, this.ctx.config.thresholds.analytics.minVideosForStrategicConclusion).slots.short, new Date(new Date(scheduled).getTime() - 59 * 60_000 + 1), restShorts.length + 1).filter((t) => t > scheduled).slice(0, restShorts.length) : [];
    for (const [i, sh] of restShorts.entries()) {
      const shortPublishAt = scheduled ? shortTimes[i] : undefined;
      try {
        const title = shortTitle(sh.title);
        const r = await yt.upload({
          videoPath: sh.path,
          title,
          description: pack ? `${description}\n#Shorts` : `القصة كاملة: https://youtu.be/${res.youtubeVideoId}\n\n${seo.hashtags.join(' ')} #Shorts`,
          tags: seo.tags,
          visibility,
          publishAt: shortPublishAt,
          containsSyntheticMedia: compliance.requiresSyntheticDisclosure,
          defaultLanguage: this.ctx.config.channel.language,
        });
        shorts.push({ youtubeVideoId: r.youtubeVideoId, title, publishAt: shortPublishAt });
        this.ctx.cost.record({ provider: yt.name, operation: 'videos.insert.short', videoId, units: 1600, unit: 'requests', usd: 0 });
      } catch (err) {
        // The long video is already up; a failed Short must not fail the whole publish.
        this.ctx.logger.warn('short upload failed', { videoId, error: (err as Error).message });
      }
    }
    for (const w of res.warnings ?? []) this.ctx.logger.warn(w, { videoId });
    if ((res.warnings ?? []).some((w) => w.startsWith('YOUTUBE_LOCKED_PRIVATE'))) {
      this.ctx.repos.videos.update(videoId, { status: 'uploaded', visibility: 'private', scheduled_at: null });
      this.ctx.audit.record({ actor: this.name, action: 'video.locked_private', target: videoId });
    }
    return { ...res, videoId, provider: yt.name, dryRun: env.DRY_RUN, uploadedAt: new Date().toISOString(), attempts, shorts };
  }
}
