import type { Db } from '../database/db.ts';
import { newId, nowIso } from '../database/db.ts';
import { redact } from './logger.ts';

export interface AuditEntry { actor: string; action: string; target?: string; details?: Record<string, unknown> }

/** Append-only audit trail. Details are redacted before storage. */
export class AuditLog {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  record(e: AuditEntry) {
    this.db.run('INSERT INTO audit_log (id, actor, action, target, details, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      newId('aud'), e.actor, e.action, e.target ?? null, e.details ? JSON.stringify(redact(e.details)) : null, nowIso(),
    ]);
  }

  recent(limit = 50) {
    return this.db.all<{ actor: string; action: string; target: string | null; details: string | null; created_at: string }>(
      'SELECT actor, action, target, details, created_at FROM audit_log ORDER BY created_at DESC, rowid DESC LIMIT ?',
      [limit],
    );
  }
}
