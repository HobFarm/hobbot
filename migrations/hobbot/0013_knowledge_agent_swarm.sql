-- Knowledge Agent Swarm: inter-agent protocol + feed_entries extensions
-- Supports conductor (gap analysis) -> knowledge_requests -> source agents -> feed_entries -> pipeline

-- Knowledge requests: conductor writes what the Grimoire needs, agents pick up work
CREATE TABLE IF NOT EXISTS knowledge_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- What's needed
  request_type TEXT NOT NULL,              -- 'baseline', 'gap_fill', 'deepen', 'cross_reference'
  target_arrangements TEXT,                -- JSON array: ['bauhaus', 'constructivism']
  target_categories TEXT,                  -- JSON array: ['covering.material', 'style.medium']
  search_intent TEXT NOT NULL,             -- natural language description of what's needed
  priority REAL DEFAULT 0.5,              -- 0-1, conductor sets based on gap severity

  -- Source routing
  source_agent TEXT,                       -- 'archive_org', 'getty', null (any agent can claim)

  -- Lifecycle
  status TEXT DEFAULT 'pending',           -- pending, claimed, searching, ingesting, complete, failed, stale
  claimed_by TEXT,                         -- which agent instance claimed it
  claimed_at TEXT,                         -- when claimed (stale detection: >2h uncompleted = release)

  -- Agent work product
  search_queries TEXT,                     -- JSON: source-specific queries the agent generated
  candidates_found INTEGER DEFAULT 0,     -- how many potential sources found
  candidates_evaluated INTEGER DEFAULT 0, -- how many evaluated for quality
  items_ingested INTEGER DEFAULT 0,       -- how many actually fed to pipeline
  items_skipped INTEGER DEFAULT 0,        -- how many rejected (quality, duplicate, etc)
  skip_reasons TEXT,                       -- JSON: why items were skipped

  -- Results
  atoms_created INTEGER DEFAULT 0,        -- total new atoms from all ingested items
  atoms_matched INTEGER DEFAULT 0,        -- total matched existing atoms
  result_notes TEXT,                       -- agent's summary of what it found/didn't find
  remaining_gaps TEXT,                     -- JSON: what the agent couldn't fill

  -- Timestamps
  created_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX idx_kr_status ON knowledge_requests(status);
CREATE INDEX idx_kr_source ON knowledge_requests(source_agent, status);

-- Extend feed_entries for agent usage (all columns nullable, existing rows unaffected)
ALTER TABLE feed_entries ADD COLUMN mime_type TEXT;
ALTER TABLE feed_entries ADD COLUMN source_type TEXT;
ALTER TABLE feed_entries ADD COLUMN metadata TEXT;
ALTER TABLE feed_entries ADD COLUMN knowledge_request_id INTEGER REFERENCES knowledge_requests(id);

CREATE INDEX idx_feed_entries_kr ON feed_entries(knowledge_request_id);

-- Source rows for knowledge agents
INSERT OR IGNORE INTO sources (id, name, type, endpoint_url, sync_cadence, transform_module, target_collection, enabled)
VALUES ('archive-org-agent', 'Internet Archive Agent', 'rest_api', 'https://archive.org', 'on_demand', 'archive-org', 'uncategorized', 1);

INSERT OR IGNORE INTO sources (id, name, type, endpoint_url, sync_cadence, transform_module, target_collection, enabled)
VALUES ('getty-portal-agent', 'Getty Research Portal Agent', 'rest_api', 'https://portal.getty.edu', 'on_demand', 'getty-portal', 'uncategorized', 1);
