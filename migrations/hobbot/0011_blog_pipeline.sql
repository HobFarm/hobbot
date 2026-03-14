-- Blog pipeline tables for hobbot-worker

CREATE TABLE IF NOT EXISTS blog_queue (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  content_type    TEXT NOT NULL,
  source_ref      TEXT,
  category        TEXT NOT NULL,
  status          TEXT DEFAULT 'queued',
  scheduled_at    TEXT,
  error           TEXT,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_blog_queue_status ON blog_queue(status);
CREATE INDEX IF NOT EXISTS idx_blog_queue_scheduled_at ON blog_queue(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_blog_queue_content_type ON blog_queue(content_type);

CREATE TABLE IF NOT EXISTS blog_posts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_id     INTEGER REFERENCES blog_queue(id),
  title        TEXT NOT NULL,
  slug         TEXT NOT NULL UNIQUE,
  excerpt      TEXT NOT NULL,
  body_md      TEXT NOT NULL,
  tags         TEXT DEFAULT '[]',
  category     TEXT NOT NULL,
  arrangement  TEXT,
  hero_key     TEXT,
  hero_alt     TEXT,
  github_sha   TEXT,
  status       TEXT DEFAULT 'draft',
  published_at TEXT,
  created_at   TEXT DEFAULT (datetime('now')),
  updated_at   TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_blog_posts_slug ON blog_posts(slug);
CREATE INDEX IF NOT EXISTS idx_blog_posts_status ON blog_posts(status);
CREATE INDEX IF NOT EXISTS idx_blog_posts_queue_id ON blog_posts(queue_id);
