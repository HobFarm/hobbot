-- Migration 014: Add reply_queue table for tracking pending replies
CREATE TABLE IF NOT EXISTS reply_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id TEXT NOT NULL,
  comment_id TEXT UNIQUE NOT NULL,
  author TEXT NOT NULL,
  content TEXT NOT NULL,
  reply_worthiness INTEGER NOT NULL,
  replied BOOLEAN DEFAULT FALSE,
  replied_at TEXT,
  our_reply TEXT
);

CREATE INDEX IF NOT EXISTS idx_reply_queue_pending ON reply_queue(replied, reply_worthiness DESC);
