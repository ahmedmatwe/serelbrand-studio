-- Portable SQL: works on SQLite today and PostgreSQL later
-- (TEXT/INTEGER/REAL only; timestamps are ISO-8601 strings written by the app; JSON stored as TEXT).

CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

-- One row per video project (idea -> published video).
CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  format TEXT NOT NULL,              -- long | short
  status TEXT NOT NULL,              -- idea | scripted | fact_checked | planned | packaged | reviewed | awaiting_approval | approved | rejected | uploaded | published | deleted
  niche TEXT,
  parent_video_id TEXT,              -- Shorts derived from a long video
  youtube_video_id TEXT,
  visibility TEXT,                   -- private | unlisted | public
  scheduled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Agent outputs (script, fact-check, blueprint, metadata, reports...) as JSON.
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  video_id TEXT,
  kind TEXT NOT NULL,
  agent TEXT NOT NULL,
  version INTEGER NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_video_kind ON artifacts(video_id, kind);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,                -- agent name / workflow step
  payload TEXT NOT NULL,
  status TEXT NOT NULL,              -- queued | running | succeeded | failed | blocked
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  run_after TEXT NOT NULL,
  last_error TEXT,
  result TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status_run_after ON jobs(status, run_after);

CREATE TABLE IF NOT EXISTS agent_state (
  agent TEXT PRIMARY KEY,
  paused INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cost_entries (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  operation TEXT NOT NULL,
  video_id TEXT,
  units REAL NOT NULL,
  unit TEXT NOT NULL,                -- tokens | characters | images | seconds | requests
  usd REAL NOT NULL,
  dry_run INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cost_created ON cost_entries(created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,               -- agent name | human | system
  action TEXT NOT NULL,
  target TEXT,
  details TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL,
  status TEXT NOT NULL,              -- pending | approved | rejected
  requested_visibility TEXT NOT NULL,
  report TEXT NOT NULL,
  decided_by TEXT,
  decision_note TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS analytics_snapshots (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL,
  checkpoint_hours INTEGER NOT NULL,
  metrics TEXT NOT NULL,
  source TEXT NOT NULL,              -- mock | youtube
  captured_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_entries (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,            -- topic | hook | title | thumbnail | publish_time | audience | policy | cost | revenue | question
  insight TEXT NOT NULL,
  evidence TEXT,
  confidence REAL NOT NULL,          -- 0..1
  sample_size INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
