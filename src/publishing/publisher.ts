import { Agent, type AgentContext } from '../agents/base.ts';
import type { ComplianceReport } from '../agents/compliance.ts';
import type { FactCheckReport, Script, SeoPackage } from '../agents/schemas.ts';
import { composeDescription } from '../agents/seo.ts';
import { PublishBlockedError } from '../core/errors.ts';
import { withRetry } from '../core/retry.ts';
import type { UploadResult, Visibility } from '../providers/media.ts';
import type { PrePublicationReport } from '../reports/prepublication.ts';
import { currentSlots, nextSlots } from './schedule.ts';
import { buildReport } from './approval.ts';
import { EXPERIMENTAL, qcBlockers, qualityChecklist } from '../reports/qc.ts';

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
    const qc = qcBlockers(qualityChecklist(this.ctx, videoId));
    if (qc.length) throw new PublishBlockedError(`Final checklist failed: ${qc.join('; ')}`);
    const current = buildReport(this.ctx, videoId);
    if (current.hardBlockers.length) throw new PublishBlockedError(`Current quality gate failed: ${current.hardBlockers.join('; ')}`);
    if (current.qualityScore < this.ctx.config.thresholds.quality.minScoreToPublish) throw new PublishBlockedError('Current quality score is below publishing threshold');

    const scheduled = approval.requested_visibility.startsWith('scheduled:') ? approval.requested_visibility.slice('scheduled:'.length) : undefined;
    const visibility = (scheduled ? 'private' : approval.requested_visibility) as Visibility;
    const { env } = this.ctx.config;
    if ((visibility === 'public' || scheduled) && !env.ALLOW_PUBLIC_PUBLISHING) throw new PublishBlockedError('Public publishing is disabled (ALLOW_PUBLIC_PUBLISHING=false)');

    const render = this.ctx.repos.artifacts.latest<{ videoPath: string; thumbnailPath?: string; captionsPath?: string; captionsEnPath?: string; shorts?: { path: string; title: string; scenes?: number[] }[]; packOnly?: boolean; voice: { provider: string; voice: string; synthetic: boolean }; assets?: { source: string; attribution?: string; pageUrl?: string }[] }>(videoId, 'render');
    if (!render && !env.DRY_RUN) throw new PublishBlockedError('No rendered video file yet (rendering arrives in phase 4)');
    if (!env.DRY_RUN && render?.data.voice.provider.toLowerCase().includes('mock')) throw new PublishBlockedError('Experimental/mock voice can never be uploaded');
    if (!env.DRY_RUN && EXPERIMENTAL.test([video.title, render?.data.voice.provider, render?.data.voice.voice].filter(Boolean).join(' '))) {
      throw new PublishBlockedError('Experimental/test output can never be uploaded');
    }

    const seo = this.ctx.repos.artifacts.latest<SeoPackage>(videoId, 'seo_package')!.data;
    const compliance = this.ctx.repos.artifacts.latest<ComplianceReport>(videoId, 'compliance_report')!.data;
    const yt = this.ctx.providers.youtube;
    // Shorts pack: the first Short is the "main" upload; the others follow 4 h apart.
    const pack = Boolean(render?.data.packOnly && render.data.shorts?.length);
    // YouTube's free API quota (~10,000 units/day, 1,600 per upload) allows ~6 uploads per Pacific day.
    // Never start a batch that would hit the limit half-way: the video stays approved and the next cycle uploads it.
    const need = pack ? render!.data.shorts!.length : 1 + (render?.data.shorts?.length ?? 0);
    const used = uploadsToday(this.ctx);
    if (!env.DRY_RUN && used + need > env.YOUTUBE_DAILY_UPLOADS) throw new PublishBlockedError(`UPLOAD_QUOTA: ${used} uploads today + ${need} would exceed ${env.YOUTUBE_DAILY_UPLOADS} — will upload after the daily reset`);
    const shortTitle = (t: string) => `${t.replace(/#\S+/g, '').trim().slice(0, 88)} #Shorts`;
    const factCheck = this.ctx.repos.artifacts.latest<FactCheckReport>(videoId, 'fact_check')?.data;
    const description = composeDescription(seo, factCheck, render?.data.assets);
    // A Shorts pack = 3 different topics: each Short gets a description of ITS OWN topic (its opening lines +
    // its own verified sources), never one mixed summary of all three.
    const script = this.ctx.repos.artifacts.latest<Script>(videoId, 'script')?.data;
    const packDescription = (scenes: number[] | undefined) => {
      const sc = script?.scenes.find((x) => scenes?.includes(x.n));
      if (!pack || !sc) return `${description}\n#Shorts`;
      const lead = (sc.voiceover.match(/[^.!؟?…]+[.!؟?…]+/g) ?? [sc.voiceover]).slice(0, 2).join(' ').trim();
      const own = factCheck ? { ...factCheck, claims: factCheck.claims.filter((c) => c.sceneN === sc.n) } : undefined;
      return `${composeDescription({ description: lead, hashtags: seo.hashtags, chapters: [] }, own, render?.data.assets)}\n#Shorts`;
    };
    let attempts = 0;
    const res = await withRetry(
      () => {
        attempts++;
        return yt.upload({
          videoPath: pack ? render!.data.shorts![0]!.path : render?.data.videoPath ?? `mock://render/${videoId}.mp4`,
          thumbnailPath: pack ? undefined : render?.data.thumbnailPath || undefined,
          captionsPath: pack ? undefined : render?.data.captionsPath || undefined,
          extraCaptions: !pack && render?.data.captionsEnPath ? [{ path: render.data.captionsEnPath, language: 'en', name: 'English' }] : undefined,
          title: pack ? shortTitle(render!.data.shorts![0]!.title) : seo.primaryTitle,
          description: pack ? packDescription(render!.data.shorts![0]!.scenes) : description,
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
          description: pack ? packDescription(sh.scenes) : `القصة كاملة: https://youtu.be/${res.youtubeVideoId}\n\n${seo.hashtags.join(' ')} #Shorts`,
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

/** Uploads (main + Shorts) made since the last YouTube quota reset (midnight Pacific time). */
export function uploadsToday(ctx: AgentContext, now = new Date()): number {
  const pt = (d: Date) => new Date(d.getTime() - 8 * 3600_000).toISOString().slice(0, 10); // PST (conservative)
  const today = pt(now);
  let n = 0;
  for (const a of ctx.repos.artifacts.listKind<PublishLog>('publish_log')) {
    const l = a.data;
    if (l.dryRun || !l.uploadedAt || pt(new Date(l.uploadedAt)) !== today) continue;
    n += (l.youtubeVideoId ? 1 : 0) + (l.shorts?.length ?? 0);
  }
  return n;
}
