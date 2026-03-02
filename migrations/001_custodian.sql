-- Custodian tables for HobBot Grimoire worker
-- Do NOT touch existing tables: atoms, categories, collections, arrangements,
-- app_routing, classification_cache, category_relations, category_contexts

-- Usage telemetry
CREATE TABLE IF NOT EXISTS usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  query TEXT,
  atom_ids_returned TEXT DEFAULT '[]',
  response_time_ms INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_usage_log_agent ON usage_log(agent, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_log_endpoint ON usage_log(endpoint, created_at DESC);

-- Validation event log
CREATE TABLE IF NOT EXISTS validation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_type TEXT NOT NULL CHECK(trigger_type IN ('write', 'scan', 'demand')),
  atom_id TEXT,
  result TEXT NOT NULL CHECK(result IN ('pass', 'warn', 'fail')),
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_validation_log_result ON validation_log(result, created_at DESC);

-- Integrity scan results
CREATE TABLE IF NOT EXISTS integrity_scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_type TEXT NOT NULL CHECK(scan_type IN ('full', 'write_validation', 'on_demand', 'evolve')),
  atoms_scanned INTEGER NOT NULL,
  issues_found INTEGER NOT NULL DEFAULT 0,
  issues TEXT NOT NULL DEFAULT '[]',
  duration_ms INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Agent budget tracking
CREATE TABLE IF NOT EXISTS agent_budgets (
  agent TEXT PRIMARY KEY,
  queries_today INTEGER DEFAULT 0,
  queries_limit INTEGER DEFAULT 1000,
  last_query_at TEXT,
  budget_date TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Weekly evolve reports (written by EVOLVE cron)
CREATE TABLE IF NOT EXISTS evolve_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  total_atoms INTEGER NOT NULL,
  classified_atoms INTEGER NOT NULL,
  total_correspondences INTEGER NOT NULL,
  correspondence_breakdown TEXT NOT NULL DEFAULT '{}',
  orphan_count INTEGER NOT NULL DEFAULT 0,
  category_coverage TEXT NOT NULL DEFAULT '{}',
  sparse_categories TEXT NOT NULL DEFAULT '[]',
  recommendations TEXT NOT NULL DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now'))
);
