-- Phase 3: Validation failures tracking table
-- Records pre-Layer 1 rejections for instruction-shaped content

CREATE TABLE IF NOT EXISTS validation_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author TEXT,
  post_id TEXT,
  threats TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  detected_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_validation_author ON validation_failures(author);
CREATE INDEX IF NOT EXISTS idx_validation_detected ON validation_failures(detected_at);
