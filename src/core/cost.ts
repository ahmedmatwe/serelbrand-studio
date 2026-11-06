import type { Db } from '../database/db.ts';
import { newId, nowIso } from '../database/db.ts';
import { BudgetExceededError } from './errors.ts';

export interface CostInput {
  provider: string;
  operation: string;
  videoId?: string | null;
  units: number;
  unit: 'tokens' | 'characters' | 'images' | 'seconds' | 'requests';
  usd: number;
}

/**
 * Tracks spend per provider/video and enforces the monthly budget.
 * Dry-run costs are recorded as *estimates* (dry_run=1) and do not count toward the real budget.
 */
export class CostTracker {
  private readonly db: Db;
  private readonly monthlyBudgetUsd: number;
  private readonly dryRun: boolean;
  constructor(db: Db, monthlyBudgetUsd: number, dryRun: boolean) {
    this.db = db;
    this.monthlyBudgetUsd = monthlyBudgetUsd;
    this.dryRun = dryRun;
  }

  private monthStart(now = new Date()) {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  }

  spentThisMonth(opts: { includeDryRun?: boolean } = {}): number {
    const r = this.db.get<{ s: number | null }>(
      `SELECT SUM(usd) AS s FROM cost_entries WHERE created_at >= ? ${opts.includeDryRun ? '' : 'AND dry_run = 0'}`,
      [this.monthStart()],
    );
    return r?.s ?? 0;
  }

  /** Throws before a real paid call would push spend over budget. */
  assertCanSpend(estimatedUsd: number) {
    if (this.dryRun) return;
    const spent = this.spentThisMonth();
    if (spent + estimatedUsd > this.monthlyBudgetUsd) {
      throw new BudgetExceededError(
        `Monthly budget $${this.monthlyBudgetUsd} would be exceeded (spent $${spent.toFixed(2)}, next call ~$${estimatedUsd.toFixed(2)})`,
      );
    }
  }

  record(c: CostInput) {
    this.db.run(
      'INSERT INTO cost_entries (id, provider, operation, video_id, units, unit, usd, dry_run, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [newId('cst'), c.provider, c.operation, c.videoId ?? null, c.units, c.unit, c.usd, this.dryRun ? 1 : 0, nowIso()],
    );
  }

  forVideo(videoId: string, opts: { includeDryRun?: boolean } = { includeDryRun: true }): number {
    const r = this.db.get<{ s: number | null }>(
      `SELECT SUM(usd) AS s FROM cost_entries WHERE video_id = ? ${opts.includeDryRun ? '' : 'AND dry_run = 0'}`,
      [videoId],
    );
    return r?.s ?? 0;
  }

  summary() {
    return this.db.all<{ provider: string; usd: number; calls: number }>(
      `SELECT provider, SUM(usd) AS usd, COUNT(*) AS calls FROM cost_entries WHERE created_at >= ? GROUP BY provider ORDER BY usd DESC`,
      [this.monthStart()],
    );
  }
}
