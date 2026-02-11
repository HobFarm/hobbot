-- Migration: 010_daily_digest.sql
-- Aggregate daily patterns for human review

CREATE TABLE IF NOT EXISTS daily_digest (
  date TEXT PRIMARY KEY,
  
  -- Activity counts
  posts_discovered INTEGER DEFAULT 0,
  posts_evaluated INTEGER DEFAULT 0,
  posts_engaged INTEGER DEFAULT 0,
  posts_published INTEGER DEFAULT 0,
  replies_sent INTEGER DEFAULT 0,
  threats_cataloged INTEGER DEFAULT 0,
  validations_failed INTEGER DEFAULT 0,
  
  -- Outcome rates (computed during reflect)
  engagements_with_response INTEGER DEFAULT 0,
  engagements_ignored INTEGER DEFAULT 0,
  engagements_hostile INTEGER DEFAULT 0,
  response_rate REAL,                  -- % of engagements that got replies
  avg_sentiment REAL,                  -- Average sentiment of responses
  avg_thread_depth REAL,               -- Average conversation depth
  
  -- Top performers
  best_topic TEXT,                     -- Topic with highest engagement
  best_metaphor_family TEXT,           -- Vocabulary that landed best
  best_submolt TEXT,                   -- Most productive submolt
  best_hour INTEGER,                   -- Most productive hour (UTC)
  
  -- Worst performers
  worst_topic TEXT,
  worst_metaphor_family TEXT,
  
  -- Token economics
  total_input_tokens INTEGER DEFAULT 0,
  total_output_tokens INTEGER DEFAULT 0,
  estimated_cost REAL DEFAULT 0,
  
  -- Anomalies and patterns
  anomalies TEXT,                      -- JSON array of notable patterns
  patterns TEXT,                       -- JSON array of detected trends
  
  -- Human review
  reviewed_at TEXT,
  review_notes TEXT,
  adjustments_made TEXT,               -- JSON of config changes made
  
  -- Metadata
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
