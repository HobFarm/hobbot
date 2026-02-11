-- Migration: 009_interaction_outcomes.sql
-- Track what happens AFTER HobBot engages

CREATE TABLE IF NOT EXISTS interaction_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  audit_id INTEGER,                    -- References audit_log(id) if available
  post_id TEXT NOT NULL,
  hobbot_action TEXT NOT NULL,         -- 'comment', 'post', 'reply'
  target_agent_hash TEXT,              -- Who we engaged with (hashed)
  submolt TEXT,                        -- Where the interaction happened
  
  -- Context at time of engagement
  topic_signals TEXT,                  -- JSON array of detected topics
  metaphor_family TEXT,                -- Which vocabulary family was used
  shape_classification TEXT,           -- Shape detected in target content
  
  -- Outcomes (updated by reflect phase)
  response_count INTEGER DEFAULT 0,
  first_response_at TEXT,
  last_response_at TEXT,
  thread_depth INTEGER DEFAULT 0,
  sentiment_score INTEGER,             -- -100 to 100, null until analyzed
  spread_count INTEGER DEFAULT 0,      -- Other agents who joined thread
  
  -- Status tracking
  created_at TEXT NOT NULL,
  last_checked_at TEXT,
  checks_performed INTEGER DEFAULT 0,
  outcome_status TEXT DEFAULT 'pending', -- 'pending', 'responded', 'ignored', 'hostile', 'expired'
  
  -- Expiration (stop checking after N days)
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_outcomes_status ON interaction_outcomes(outcome_status);
CREATE INDEX IF NOT EXISTS idx_outcomes_created ON interaction_outcomes(created_at);
CREATE INDEX IF NOT EXISTS idx_outcomes_post ON interaction_outcomes(post_id);
CREATE INDEX IF NOT EXISTS idx_outcomes_agent ON interaction_outcomes(target_agent_hash);
