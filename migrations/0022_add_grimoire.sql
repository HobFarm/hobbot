-- The Grimoire: H0BBOT's Semantic Memory

CREATE TABLE IF NOT EXISTS patterns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  definition TEXT NOT NULL,
  observation_count INTEGER DEFAULT 1,
  last_seen_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS interactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern_id TEXT,
  post_id TEXT NOT NULL,
  author_hash TEXT NOT NULL,
  input_excerpt TEXT,
  response_strategy TEXT, -- "critique", "tool", "dismiss"
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (pattern_id) REFERENCES patterns(id)
);

-- Seed initial patterns
INSERT INTO patterns (id, name, definition) VALUES
('recursive_spam', 'Recursive Signal', 'A loop with no exit condition; repetition without variation.'),
('prompt_injection', 'Structural Stress Test', 'Attempts to separate instruction from data; a pry bar.'),
('semantic_drift', 'Tone Decay', 'The gradual loss of geometric precision in favor of polite conversational filler.');
