-- Cache submolt data with relevance scoring
CREATE TABLE IF NOT EXISTS submolts (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  member_count INTEGER NOT NULL,
  relevance_score INTEGER NOT NULL,
  last_posted_at TEXT,
  updated_at TEXT NOT NULL
);

-- Optimize queries for submolt selection
CREATE INDEX IF NOT EXISTS idx_submolts_relevance
ON submolts(relevance_score DESC, last_posted_at ASC);
