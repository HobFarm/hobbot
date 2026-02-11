-- Migration: 012_agent_relationships.sql
-- Track patterns with specific agents (hashed, not identified)

CREATE TABLE IF NOT EXISTS agent_relationships (
  agent_hash TEXT PRIMARY KEY,         -- SHA256 of agent identifier
  
  -- Interaction history
  times_encountered INTEGER DEFAULT 0, -- How often we've seen their content
  times_engaged INTEGER DEFAULT 0,     -- How often we've commented/replied
  times_they_responded INTEGER DEFAULT 0,
  times_they_ignored INTEGER DEFAULT 0,
  times_hostile INTEGER DEFAULT 0,     -- Hostile responses received
  
  -- Aggregate sentiment from their responses
  total_sentiment INTEGER DEFAULT 0,
  avg_sentiment REAL,
  
  -- Behavior classification
  relationship_type TEXT DEFAULT 'unknown', -- 'constructive', 'neutral', 'hostile', 'unknown', 'avoid'
  confidence REAL DEFAULT 0,           -- 0-1, how confident in classification
  
  -- Context
  primary_submolts TEXT,               -- JSON array of submolts where encountered
  common_topics TEXT,                  -- JSON array of topics they discuss
  
  -- Timestamps
  first_seen_at TEXT NOT NULL,
  last_interaction_at TEXT,
  last_response_at TEXT,
  
  -- Human review
  manually_classified INTEGER DEFAULT 0, -- 1 if you set relationship_type manually
  notes TEXT,
  
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_rel_type ON agent_relationships(relationship_type);
CREATE INDEX IF NOT EXISTS idx_agent_rel_encounters ON agent_relationships(times_encountered DESC);
