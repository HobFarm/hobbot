-- Migration: Add author signals tracking
-- Tracks author interaction patterns

CREATE TABLE IF NOT EXISTS author_signals (
  author_hash TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  post_id TEXT NOT NULL,
  PRIMARY KEY (author_hash, timestamp)
);

CREATE INDEX IF NOT EXISTS idx_author_signals_author_time
ON author_signals(author_hash, timestamp);
