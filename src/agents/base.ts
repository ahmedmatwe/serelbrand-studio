import type { AppConfig } from '../core/config.ts';
import type { Logger } from '../core/logger.ts';
import type { AuditLog } from '../core/audit.ts';
import type { CostTracker } from '../core/cost.ts';
import { AgentPausedError } from '../core/errors.ts';
import type { AgentStateRepo, ArtifactRepo, VideoRepo, ApprovalRepo, AnalyticsRepo, KnowledgeRepo } from '../database/repositories.ts';
import type { TrackedLLM } from '../providers/llm/tracked.ts';
import type { ImageProvider, StockProvider, TrendsProvider, TTSProvider, YouTubeProvider } from '../providers/media.ts';
import type { WebProvider } from '../providers/web/web.ts';
import type { JobQueue } from '../queue/queue.ts';

/** Everything an agent may use. Built once by `createContext()`. */
export interface AgentContext {
  config: AppConfig;
  logger: Logger;
  audit: AuditLog;
  cost: CostTracker;
  repos: {
    videos: VideoRepo;
    artifacts: ArtifactRepo;
    agentState: AgentStateRepo;
    approvals: ApprovalRepo;
    analytics: AnalyticsRepo;
    knowledge: KnowledgeRepo;
  };
  providers: {
    llm: TrackedLLM;
    trends: TrendsProvider;
    tts: TTSProvider;
    image: ImageProvider;
    stock: StockProvider;
    /** Real photos of named people/companies/products (Wikimedia Commons). Absent in offline runs. */
    photos?: StockProvider;
    youtube: YouTubeProvider;
    web: WebProvider;
  };
  queue: JobQueue;
}

/**
 * Base class: pause check, audit trail, artifact persistence.
 * Subclasses implement `execute()` only.
 */
export abstract class Agent<I, O> {
  abstract readonly name: string;
  /** Artifact kind stored after a successful run. */
  abstract readonly artifactKind: string;
  protected readonly ctx: AgentContext;
  constructor(ctx: AgentContext) { this.ctx = ctx; }

  protected abstract execute(input: I): Promise<O>;

  /** Used to link the stored artifact to a video (null = channel-level artifact). */
  protected videoIdOf(input: I): string | null {
    const v = (input as { videoId?: unknown })?.videoId;
    return typeof v === 'string' ? v : null;
  }

  async run(input: I): Promise<O> {
    if (this.ctx.repos.agentState.isPaused(this.name)) throw new AgentPausedError(this.name);
    const log = this.ctx.logger.child(this.name);
    const started = Date.now();
    log.info('start');
    const output = await this.execute(input);
    const videoId = this.videoIdOf(input);
    const art = this.ctx.repos.artifacts.save({ videoId, kind: this.artifactKind, agent: this.name, data: output });
    this.ctx.audit.record({ actor: this.name, action: 'agent.completed', target: videoId ?? undefined, details: { artifactId: art.id, ms: Date.now() - started } });
    log.info('done', { ms: Date.now() - started, artifact: art.id });
    return output;
  }
}

/** Arabic-aware word counter (Arabic, Latin and digits). */
export function countWords(text: string): number {
  return (text.match(/[\p{L}\p{M}\p{N}]+/gu) ?? []).length;
}

export const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
export const levelScore = (l: 'low' | 'medium' | 'high', invert = false) => {
  const s = { low: 30, medium: 60, high: 90 }[l];
  return invert ? 120 - s : s;
};
