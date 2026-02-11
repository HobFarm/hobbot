-- Migration 018: Drift Attack Tracking
-- Extends author_signals and adds tables for attack pattern detection

-- Columns signal_type, content_hash, emoji_signature, attack_type
-- already exist on author_signals (applied manually before migration tracking)

CREATE INDEX IF NOT EXISTS idx_author_signals_type
ON author_signals(author_hash, signal_type, timestamp);

-- Track same-thread sequential posts for escalation detection
CREATE TABLE IF NOT EXISTS thread_author_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  author_hash TEXT NOT NULL,
  comment_count INTEGER DEFAULT 1,
  escalation_detected BOOLEAN DEFAULT FALSE,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  UNIQUE(thread_id, author_hash)
);

CREATE INDEX IF NOT EXISTS idx_thread_activity
ON thread_author_activity(thread_id, author_hash);

-- Track comment content for near-duplicate detection
CREATE TABLE IF NOT EXISTS thread_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  author_hash TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content_preview TEXT NOT NULL,
  timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_thread_comments_lookup
ON thread_comments(thread_id, author_hash, timestamp DESC);
