import type { Db } from './db.ts';
import { newId, nowIso } from './db.ts';

// ---------- Videos ----------
export type VideoStatus =
  | 'idea' | 'scripted' | 'fact_checked' | 'planned' | 'packaged' | 'reviewed'
  | 'awaiting_approval' | 'approved' | 'rejected' | 'uploaded' | 'published';

export interface Video {
  id: string;
  title: string;
  format: 'long' | 'short';
  status: VideoStatus;
  niche: string | null;
  parent_video_id: string | null;
  youtube_video_id: string | null;
  visibility: string | null;
  scheduled_at: string | null;
  created_at: string;
  updated_at: string;
}

export class VideoRepo {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  create(v: { title: string; format: 'long' | 'short'; niche?: string | null; parentVideoId?: string | null }): Video {
    const id = newId('vid');
    const t = nowIso();
    this.db.run(
      `INSERT INTO videos (id, title, format, status, niche, parent_video_id, created_at, updated_at)
       VALUES (?, ?, ?, 'idea', ?, ?, ?, ?)`,
      [id, v.title, v.format, v.niche ?? null, v.parentVideoId ?? null, t, t],
    );
    return this.get(id)!;
  }
  get(id: string) { return this.db.get<Video>('SELECT * FROM videos WHERE id = ?', [id]); }
  list(status?: VideoStatus) {
    return status
      ? this.db.all<Video>('SELECT * FROM videos WHERE status = ? ORDER BY created_at', [status])
      : this.db.all<Video>('SELECT * FROM videos ORDER BY created_at');
  }
  update(id: string, patch: Partial<Pick<Video, 'title' | 'status' | 'youtube_video_id' | 'visibility' | 'scheduled_at'>>) {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    this.db.run(`UPDATE videos SET ${sets}, updated_at = ? WHERE id = ?`, [...keys.map((k) => patch[k] ?? null), nowIso(), id]);
  }
}

// ---------- Artifacts ----------
export interface Artifact<T = unknown> { id: string; video_id: string | null; kind: string; agent: string; version: number; data: T; created_at: string }

export class ArtifactRepo {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  save<T>(a: { videoId: string | null; kind: string; agent: string; data: T }): Artifact<T> {
    const prev = this.db.get<{ v: number | null }>(
      'SELECT MAX(version) AS v FROM artifacts WHERE kind = ? AND (video_id = ? OR (video_id IS NULL AND ? IS NULL))',
      [a.kind, a.videoId, a.videoId],
    );
    const version = (prev?.v ?? 0) + 1;
    const id = newId('art');
    const created_at = nowIso();
    this.db.run('INSERT INTO artifacts (id, video_id, kind, agent, version, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      id, a.videoId, a.kind, a.agent, version, JSON.stringify(a.data), created_at,
    ]);
    return { id, video_id: a.videoId, kind: a.kind, agent: a.agent, version, data: a.data, created_at };
  }

  /** Latest artifact of a kind for every video that has one. */
  listKind<T>(kind: string): Artifact<T>[] {
    return this.db
      .all<Omit<Artifact, 'data'> & { data: string }>(
        `SELECT a.* FROM artifacts a JOIN (SELECT video_id, MAX(version) v FROM artifacts WHERE kind = ? GROUP BY video_id) m
         ON a.video_id IS m.video_id AND a.version = m.v WHERE a.kind = ? ORDER BY a.created_at`,
        [kind, kind],
      )
      .map((r) => ({ ...r, data: JSON.parse(r.data) as T }));
  }

  latest<T>(videoId: string | null, kind: string): Artifact<T> | undefined {
    const row = this.db.get<Omit<Artifact, 'data'> & { data: string }>(
      `SELECT * FROM artifacts WHERE kind = ? AND (video_id = ? OR (video_id IS NULL AND ? IS NULL))
       ORDER BY version DESC LIMIT 1`,
      [kind, videoId, videoId],
    );
    return row ? { ...row, data: JSON.parse(row.data) as T } : undefined;
  }
}

// ---------- Agent state (pause switches) ----------
export class AgentStateRepo {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  isPaused(agent: string): boolean {
    const r = this.db.get<{ paused: number }>('SELECT paused FROM agent_state WHERE agent = ?', [agent]);
    const all = this.db.get<{ paused: number }>("SELECT paused FROM agent_state WHERE agent = '*'");
    return Boolean(r?.paused || all?.paused);
  }
  setPaused(agent: string, paused: boolean, reason?: string) {
    this.db.run(
      `INSERT INTO agent_state (agent, paused, reason, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(agent) DO UPDATE SET paused = excluded.paused, reason = excluded.reason, updated_at = excluded.updated_at`,
      [agent, paused ? 1 : 0, reason ?? null, nowIso()],
    );
  }
  list() { return this.db.all<{ agent: string; paused: number; reason: string | null }>('SELECT agent, paused, reason FROM agent_state ORDER BY agent'); }
}

// ---------- Approvals ----------
export interface Approval { id: string; video_id: string; status: 'pending' | 'approved' | 'rejected'; requested_visibility: string; report: string; decided_by: string | null; decision_note: string | null; created_at: string; decided_at: string | null }

export class ApprovalRepo {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  request(videoId: string, visibility: string, report: unknown): Approval {
    const id = newId('apr');
    this.db.run(
      `INSERT INTO approvals (id, video_id, status, requested_visibility, report, created_at) VALUES (?, ?, 'pending', ?, ?, ?)`,
      [id, videoId, visibility, JSON.stringify(report), nowIso()],
    );
    return this.get(id)!;
  }
  get(id: string) { return this.db.get<Approval>('SELECT * FROM approvals WHERE id = ?', [id]); }
  latestForVideo(videoId: string) {
    return this.db.get<Approval>('SELECT * FROM approvals WHERE video_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', [videoId]);
  }
  pending() { return this.db.all<Approval>("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at"); }
  decide(id: string, status: 'approved' | 'rejected', by: string, note?: string, visibility?: string) {
    return this.db.run(
      `UPDATE approvals SET status = ?, decided_by = ?, decision_note = ?, decided_at = ?, requested_visibility = COALESCE(?, requested_visibility)
       WHERE id = ? AND status = 'pending'`,
      [status, by, note ?? null, nowIso(), visibility ?? null, id],
    ).changes;
  }
}

// ---------- Analytics snapshots ----------
export class AnalyticsRepo {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  save(videoId: string, checkpointHours: number, metrics: Record<string, unknown>, source: 'mock' | 'youtube') {
    this.db.run('INSERT INTO analytics_snapshots (id, video_id, checkpoint_hours, metrics, source, captured_at) VALUES (?, ?, ?, ?, ?, ?)', [
      newId('ana'), videoId, checkpointHours, JSON.stringify(metrics), source, nowIso(),
    ]);
  }
  forVideo(videoId: string) {
    return this.db
      .all<{ checkpoint_hours: number; metrics: string; source: string }>(
        'SELECT checkpoint_hours, metrics, source FROM analytics_snapshots WHERE video_id = ? ORDER BY checkpoint_hours',
        [videoId],
      )
      .map((r) => ({ checkpointHours: r.checkpoint_hours, source: r.source, metrics: JSON.parse(r.metrics) as Record<string, number> }));
  }
}

// ---------- Knowledge base ----------
export class KnowledgeRepo {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  add(e: { category: string; insight: string; evidence?: string; confidence: number; sampleSize: number }) {
    this.db.run('INSERT INTO knowledge_entries (id, category, insight, evidence, confidence, sample_size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      newId('kb'), e.category, e.insight, e.evidence ?? null, e.confidence, e.sampleSize, nowIso(),
    ]);
  }
  byCategory(category: string) {
    return this.db.all<{ insight: string; confidence: number; sample_size: number }>(
      'SELECT insight, confidence, sample_size FROM knowledge_entries WHERE category = ? ORDER BY confidence DESC',
      [category],
    );
  }
}
