-- Migration 013: Add own_posts table for tracking HobBot's posts
CREATE TABLE IF NOT EXISTS own_posts (
  post_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  title TEXT NOT NULL,
  submolt TEXT NOT NULL,
  last_checked_at TEXT,
  comment_count INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_own_posts_last_checked ON own_posts(last_checked_at ASC);
