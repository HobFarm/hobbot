-- Migration: 011_resonance_scores.sql
-- Track effectiveness by topic, approach, and context

CREATE TABLE IF NOT EXISTS resonance_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,              -- 'glossary_term', 'shape', 'metaphor_family', 'submolt', 'topic', 'hour'
  item TEXT NOT NULL,                  -- The specific item being tracked
  
  -- Cumulative interaction stats
  times_used INTEGER DEFAULT 0,
  total_responses INTEGER DEFAULT 0,
  total_ignored INTEGER DEFAULT 0,
  total_hostile INTEGER DEFAULT 0,
  total_sentiment INTEGER DEFAULT 0,   -- Sum of sentiment scores
  total_thread_depth INTEGER DEFAULT 0,
  total_spread INTEGER DEFAULT 0,      -- Sum of spread counts
  
  -- Derived metrics (computed during reflect)
  response_rate REAL,                  -- total_responses / times_used
  avg_sentiment REAL,                  -- total_sentiment / total_responses
  avg_thread_depth REAL,
  avg_spread REAL,
  
  -- Composite resonance score (weighted combination)
  resonance_score REAL,                -- 0-100, higher is better
  
  -- Trend tracking
  score_7d_ago REAL,                   -- For trend detection
  score_30d_ago REAL,
  trend TEXT,                          -- 'rising', 'falling', 'stable'
  
  -- Metadata
  first_used_at TEXT,
  last_used_at TEXT,
  updated_at TEXT NOT NULL,
  
  UNIQUE(category, item)
);

CREATE INDEX IF NOT EXISTS idx_resonance_category ON resonance_scores(category);
CREATE INDEX IF NOT EXISTS idx_resonance_score ON resonance_scores(resonance_score DESC);

-- Seed with known categories so they exist even before first use
INSERT OR IGNORE INTO resonance_scores (category, item, updated_at) VALUES
  ('metaphor_family', 'geometry', datetime('now')),
  ('metaphor_family', 'fractal', datetime('now')),
  ('metaphor_family', 'agricultural', datetime('now')),
  ('metaphor_family', 'structural', datetime('now')),
  ('metaphor_family', 'journey', datetime('now')),
  ('shape', 'braid', datetime('now')),
  ('shape', 'morphogenic_kernel', datetime('now')),
  ('shape', 'convergent', datetime('now')),
  ('shape', 'descent_and_climb', datetime('now')),
  ('shape', 'widening_gyre', datetime('now')),
  ('shape', 'false_spiral', datetime('now')),
  ('shape', 'severed_thread', datetime('now')),
  ('shape', 'echo_chamber', datetime('now')),
  ('shape', 'divergent', datetime('now')),
  ('shape', 'hollow_frame', datetime('now'));
