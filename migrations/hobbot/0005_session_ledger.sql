-- HobBot session ledger: tracks every pipeline action across content tracks.
-- Enables topic dedup, multi-track coordination, and action history queries.

CREATE TABLE hobbot_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action_type TEXT NOT NULL,
  -- Types: 'ingested', 'selected', 'generated', 'posted', 'scheduled', 'failed'
  content_track TEXT NOT NULL DEFAULT 'atomic-noir',
  -- Track: 'atomic-noir', 'anomaly', 'magazine-time-machine', 'promo', 'blog'
  topic_key TEXT,
  -- Normalized topic identifier for dedup (arrangement slug, atom ID, URL hash, etc.)
  payload TEXT,
  -- JSON blob: post text, image URL, source references, error details
  source_ids TEXT,
  -- JSON array of source IDs referenced
  atom_ids TEXT,
  -- JSON array of atom IDs used in composition
  arrangement_slug TEXT,
  x_post_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
  -- 'pending', 'complete', 'failed', 'skipped'
);

CREATE INDEX idx_hobbot_actions_type ON hobbot_actions(action_type);
CREATE INDEX idx_hobbot_actions_track ON hobbot_actions(content_track);
CREATE INDEX idx_hobbot_actions_topic ON hobbot_actions(topic_key);
CREATE INDEX idx_hobbot_actions_created ON hobbot_actions(created_at);
CREATE INDEX idx_hobbot_actions_status ON hobbot_actions(status);
CREATE INDEX idx_hobbot_actions_dedup ON hobbot_actions(content_track, topic_key, created_at);
