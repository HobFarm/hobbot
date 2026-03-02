-- HobBot X posting agent schema
-- 5 tables: posts, content_queue, post_metrics, agent_config, activity_log

CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  x_post_id TEXT UNIQUE,
  content TEXT NOT NULL,
  media_url TEXT,
  arrangement_slug TEXT,
  intent TEXT,
  status TEXT NOT NULL DEFAULT 'drafted' CHECK(status IN ('drafted', 'posted', 'failed')),
  error_message TEXT,
  posted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_posts_status ON posts(status);
CREATE INDEX idx_posts_posted_at ON posts(posted_at);

CREATE TABLE content_queue (
  id TEXT PRIMARY KEY,
  arrangement_slug TEXT,
  intent TEXT NOT NULL,
  generated_text TEXT,
  media_url TEXT,
  scheduled_for TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'generating', 'ready', 'claimed', 'posted', 'failed', 'cancelled')),
  post_id TEXT REFERENCES posts(id),
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_queue_status ON content_queue(status);
CREATE INDEX idx_queue_scheduled ON content_queue(scheduled_for);

CREATE TABLE post_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id TEXT NOT NULL REFERENCES posts(id),
  likes INTEGER DEFAULT 0,
  retweets INTEGER DEFAULT 0,
  replies INTEGER DEFAULT 0,
  impressions INTEGER DEFAULT 0,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_metrics_post ON post_metrics(post_id);
CREATE INDEX idx_metrics_fetched ON post_metrics(fetched_at);

CREATE TABLE agent_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO agent_config (key, value) VALUES
  ('persona', 'hobbot'),
  ('default_arrangement', 'atomic-noir'),
  ('posts_per_day', '3'),
  ('posting_enabled', 'false'),
  ('x_account', '@h0bbot');

CREATE TABLE activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  detail TEXT,
  outcome TEXT CHECK(outcome IN ('success', 'failure', 'skipped')),
  error_message TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_activity_action ON activity_log(action);
CREATE INDEX idx_activity_created ON activity_log(created_at);
