-- HobBot D1 Database Schema
-- Already created in D1, this is documentation only
-- DO NOT run CREATE statements - tables already exist

CREATE TABLE IF NOT EXISTS daily_budget (
  date TEXT PRIMARY KEY,
  comments_used INTEGER DEFAULT 0,
  comments_max INTEGER DEFAULT 50,
  posts_used INTEGER DEFAULT 0,
  posts_max INTEGER DEFAULT 10,
  replies_used INTEGER DEFAULT 0,
  replies_max INTEGER DEFAULT 50,
  last_post_at TEXT,
  last_comment_at TEXT,
  last_reply_at TEXT,
  last_metaphor_family TEXT DEFAULT 'geometry'
);

CREATE TABLE IF NOT EXISTS seen_posts (
  post_id TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL,
  engaged BOOLEAN DEFAULT FALSE,
  engagement_type TEXT,
  score INTEGER
);

CREATE TABLE IF NOT EXISTS attack_collection (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_number INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  geometry TEXT NOT NULL,
  technique_summary TEXT NOT NULL,
  origin_hash TEXT NOT NULL,
  severity INTEGER NOT NULL,
  response_given TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  shape_name TEXT,
  count INTEGER DEFAULT 1,
  examples TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  layer TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  estimated_cost REAL NOT NULL,
  created_at TEXT NOT NULL
);
