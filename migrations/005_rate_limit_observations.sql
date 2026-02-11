-- Phase 1: Rate limit discovery table
-- Records API response headers to determine Moltbook rate limits empirically

CREATE TABLE IF NOT EXISTS rate_limit_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL,
  method TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  rate_limit INTEGER,
  rate_remaining INTEGER,
  rate_reset INTEGER,
  retry_after INTEGER,
  observed_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_endpoint
ON rate_limit_observations(endpoint, observed_at);
