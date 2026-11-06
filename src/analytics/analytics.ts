import { Agent } from '../agents/base.ts';
import { StudioError } from '../core/errors.ts';

export interface AnalyticsInput { videoId: string; /** Checkpoints to capture (hours since publish). Default: config checkpoints that are due. */ checkpoints?: number[]; hoursSincePublish?: number }
export interface AnalyticsOutput { videoId: string; captured: number[]; snapshots: { checkpointHours: number; metrics: Record<string, number> }[] }

/** Collects performance snapshots at 1h / 6h / 24h / 72h / 7d / 28d. Idempotent per checkpoint. */
export class AnalyticsAgent extends Agent<AnalyticsInput, AnalyticsOutput> {
  readonly name = 'analytics';
  readonly artifactKind = 'analytics_run';

  protected async execute(input: AnalyticsInput): Promise<AnalyticsOutput> {
    const v = this.ctx.repos.videos.get(input.videoId);
    if (!v?.youtube_video_id) throw new StudioError('NOT_UPLOADED', `Video ${input.videoId} has not been uploaded`);
    const all = this.ctx.config.thresholds.analytics.checkpointsHours;
    const wanted = input.checkpoints ?? all.filter((h) => h <= (input.hoursSincePublish ?? 0));
    const have = new Set(this.ctx.repos.analytics.forVideo(v.id).map((s) => s.checkpointHours));
    const captured: number[] = [];
    for (const h of wanted.filter((x) => !have.has(x))) {
      const metrics = await this.ctx.providers.youtube.metrics(v.youtube_video_id, h);
      this.ctx.repos.analytics.save(v.id, h, metrics, this.ctx.providers.youtube.name.startsWith('mock') ? 'mock' : 'youtube');
      captured.push(h);
    }
    return { videoId: v.id, captured, snapshots: this.ctx.repos.analytics.forVideo(v.id) };
  }
}
