import type { Logger } from '../core/logger.ts';

export interface ScheduledTask {
  name: string;
  /** Run every N minutes. */
  everyMinutes: number;
  run: () => Promise<void>;
}

/**
 * Minimal in-process scheduler for recurring jobs (daily research, analytics checkpoints, reports).
 * Tasks never overlap with themselves; errors are logged, not thrown.
 */
export class Scheduler {
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly running = new Set<string>();
  private readonly logger: Logger;
  constructor(logger: Logger) { this.logger = logger.child('scheduler'); }

  add(task: ScheduledTask) {
    const tick = async () => {
      if (this.running.has(task.name)) return;
      this.running.add(task.name);
      try {
        await task.run();
      } catch (err) {
        this.logger.error('scheduled task failed', { task: task.name, error: (err as Error).message });
      } finally {
        this.running.delete(task.name);
      }
    };
    this.timers.push(setInterval(tick, task.everyMinutes * 60_000));
    this.logger.info('task scheduled', { task: task.name, everyMinutes: task.everyMinutes });
    return tick;
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
  }
}
