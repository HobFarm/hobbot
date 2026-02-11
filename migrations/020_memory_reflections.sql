-- Memory reflections: per-cycle journal entries with AI-generated learning summaries
CREATE TABLE IF NOT EXISTS memory_reflections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_timestamp TEXT NOT NULL,
  cycle_hour INTEGER NOT NULL,
  posts_discovered INTEGER DEFAULT 0,
  posts_engaged INTEGER DEFAULT 0,
  attacks_cataloged INTEGER DEFAULT 0,
  replies_sent INTEGER DEFAULT 0,
  learning_summary TEXT,
  knowledge_updates TEXT,
  anomalies TEXT,
  reflection_cost REAL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_reflections_cycle ON memory_reflections(cycle_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_reflections_hour ON memory_reflections(cycle_hour);
