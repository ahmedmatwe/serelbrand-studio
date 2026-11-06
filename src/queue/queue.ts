import type { Db } from '../database/db.ts';
import { newId, nowIso } from '../database/db.ts';
import { AgentPausedError, isRetryable } from '../core/errors.ts';
import type { AgentStateRepo } from '../database/repositories.ts';
import type { AuditLog } from '../core/audit.ts';
import type { Logger } from '../core/logger.ts';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'blocked';

export interface Job {
  id: string;
  type: string;
  payload: string;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  run_after: string;
  last_error: string | null;
  result: string | null;
  created_at: string;
  updated_at: string;
}

export type JobHandler = (payload: any, ctx: { jobId: string; attempt: number }) => Promise<unknown>;

export interface QueueDeps {
  db: Db;
  agentState: AgentStateRepo;
  audit: AuditLog;
  logger: Logger;
  baseBackoffMs: number;
  defaultMaxAttempts: number;
  now?: () => Date;
}

/**
 * Durable DB-backed job queue for long-running agent tasks.
 * - Jobs survive restarts (stored in `jobs`).
 * - Failures retry with exponential backoff, up to max_attempts.
 * - Jobs whose agent is paused become `blocked` and resume when unpaused.
 * - Failed jobs can be re-run manually.
 */
export class JobQueue {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly d: QueueDeps;
  constructor(deps: QueueDeps) { this.d = deps; }

  private now() { return (this.d.now ?? (() => new Date()))(); }

  register(type: string, handler: JobHandler) {
    this.handlers.set(type, handler);
  }

  enqueue(type: string, payload: unknown, opts: { maxAttempts?: number; runAfter?: Date } = {}): string {
    const id = newId('job');
    const t = nowIso();
    this.d.db.run(
      `INSERT INTO jobs (id, type, payload, status, attempts, max_attempts, run_after, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?)`,
      [id, type, JSON.stringify(payload ?? null), opts.maxAttempts ?? this.d.defaultMaxAttempts, (opts.runAfter ?? this.now()).toISOString(), t, t],
    );
    return id;
  }

  get(id: string) { return this.d.db.get<Job>('SELECT * FROM jobs WHERE id = ?', [id]); }
  list(status?: JobStatus) {
    return status
      ? this.d.db.all<Job>('SELECT * FROM jobs WHERE status = ? ORDER BY created_at', [status])
      : this.d.db.all<Job>('SELECT * FROM jobs ORDER BY created_at');
  }

  /** Atomically claims the next due job (skipping paused agents). */
  private claimNext(): Job | undefined {
    return this.d.db.transaction(() => {
      const due = this.d.db.all<Job>(
        `SELECT * FROM jobs WHERE status IN ('queued','blocked') AND run_after <= ? ORDER BY run_after, created_at LIMIT 50`,
        [this.now().toISOString()],
      );
      for (const job of due) {
        if (this.d.agentState.isPaused(job.type)) {
          if (job.status !== 'blocked') this.setStatus(job.id, 'blocked', new AgentPausedError(job.type).message);
          continue;
        }
        this.d.db.run(`UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?`, [nowIso(), job.id]);
        return this.get(job.id);
      }
      return undefined;
    });
  }

  private setStatus(id: string, status: JobStatus, error?: string | null, result?: unknown) {
    this.d.db.run('UPDATE jobs SET status = ?, last_error = ?, result = COALESCE(?, result), updated_at = ? WHERE id = ?', [
      status, error ?? null, result === undefined ? null : JSON.stringify(result), nowIso(), id,
    ]);
  }

  /** Runs one job. Returns false when nothing is due. */
  async runOnce(): Promise<boolean> {
    const job = this.claimNext();
    if (!job) return false;
    const log = this.d.logger.child('queue');
    const handler = this.handlers.get(job.type);
    if (!handler) {
      this.setStatus(job.id, 'failed', `No handler registered for "${job.type}"`);
      log.error('no handler', { jobId: job.id, type: job.type });
      return true;
    }
    try {
      const result = await handler(JSON.parse(job.payload), { jobId: job.id, attempt: job.attempts });
      this.setStatus(job.id, 'succeeded', null, result ?? null);
      this.d.audit.record({ actor: job.type, action: 'job.succeeded', target: job.id });
      log.info('job succeeded', { jobId: job.id, type: job.type, attempt: job.attempts });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const canRetry = isRetryable(err) && job.attempts < job.max_attempts;
      if (canRetry) {
        const delay = this.d.baseBackoffMs * 2 ** (job.attempts - 1);
        const runAfter = new Date(this.now().getTime() + delay).toISOString();
        this.d.db.run(`UPDATE jobs SET status = 'queued', last_error = ?, run_after = ?, updated_at = ? WHERE id = ?`, [msg, runAfter, nowIso(), job.id]);
        log.warn('job failed, will retry', { jobId: job.id, type: job.type, attempt: job.attempts, delayMs: delay, error: msg });
      } else {
        this.setStatus(job.id, 'failed', msg);
        this.d.audit.record({ actor: job.type, action: 'job.failed', target: job.id, details: { error: msg, attempts: job.attempts } });
        log.error('job failed permanently', { jobId: job.id, type: job.type, attempts: job.attempts, error: msg });
      }
    }
    return true;
  }

  /** Drains all currently-due jobs (used by CLI and tests). */
  async drain(maxJobs = 1000): Promise<number> {
    let n = 0;
    while (n < maxJobs && (await this.runOnce())) n++;
    return n;
  }

  /** Re-queues a failed job with a fresh attempt budget. */
  rerun(id: string): boolean {
    const changes = this.d.db.run(
      `UPDATE jobs SET status = 'queued', attempts = 0, last_error = NULL, run_after = ?, updated_at = ? WHERE id = ? AND status = 'failed'`,
      [this.now().toISOString(), nowIso(), id],
    ).changes;
    if (changes) this.d.audit.record({ actor: 'human', action: 'job.rerun', target: id });
    return changes > 0;
  }

  rerunAllFailed(): number {
    return this.list('failed').filter((j) => this.rerun(j.id)).length;
  }
}
