-- Phase 7: Audit log table
-- Append-only record of all HobBot actions

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT DEFAULT (datetime('now')),
  action_type TEXT NOT NULL,
  target_id TEXT,
  target_author TEXT,
  content_hash TEXT,
  outcome TEXT,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action_type);
