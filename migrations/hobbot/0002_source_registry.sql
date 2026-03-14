-- Source Registry Schema for HobBot Knowledge Agent
-- Tables: sources, source_atoms, sync_runs, feed_entries, gap_signals

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('sparql', 'rest_api', 'rss', 'bulk_download', 'web_search', 'llm')),
  endpoint_url TEXT,
  auth_method TEXT CHECK(auth_method IN ('none', 'api_key', 'bearer', 'basic')),
  auth_credential_env TEXT,
  sync_cadence TEXT NOT NULL,
  last_sync_at TEXT,
  sync_cursor TEXT,
  transform_module TEXT NOT NULL,
  target_collection TEXT NOT NULL,
  rate_limit_per_second REAL DEFAULT 1.0,
  batch_size INTEGER DEFAULT 50,
  enabled INTEGER DEFAULT 1,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE source_atoms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES sources(id),
  external_uri TEXT NOT NULL,
  grimoire_atom_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending', 'ingested', 'rejected', 'updated')),
  raw_data TEXT,
  candidate_text TEXT,
  candidate_category TEXT,
  confidence REAL,
  rejection_reason TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(source_id, external_uri)
);

CREATE INDEX idx_source_atoms_source_status ON source_atoms(source_id, status);
CREATE INDEX idx_source_atoms_external_uri ON source_atoms(external_uri);

CREATE TABLE sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES sources(id),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT CHECK(status IN ('running', 'completed', 'failed', 'partial')),
  items_fetched INTEGER DEFAULT 0,
  items_ingested INTEGER DEFAULT 0,
  items_rejected INTEGER DEFAULT 0,
  items_skipped INTEGER DEFAULT 0,
  error_message TEXT,
  cursor_before TEXT,
  cursor_after TEXT
);

CREATE INDEX idx_sync_runs_source_started ON sync_runs(source_id, started_at);

CREATE TABLE feed_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES sources(id),
  entry_url TEXT NOT NULL,
  entry_title TEXT,
  published_at TEXT,
  fetched_at TEXT DEFAULT (datetime('now')),
  extraction_status TEXT CHECK(extraction_status IN ('pending', 'extracted', 'failed', 'no_terms')),
  extracted_terms TEXT,
  UNIQUE(source_id, entry_url)
);

CREATE INDEX idx_feed_entries_source_status ON feed_entries(source_id, extraction_status);

CREATE TABLE gap_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_type TEXT NOT NULL CHECK(signal_type IN (
    'sparse_arrangement', 'orphan_atom', 'harmonic_dead_zone',
    'context_gap', 'feed_discovery'
  )),
  arrangement_slug TEXT,
  category_slug TEXT,
  description TEXT NOT NULL,
  priority REAL DEFAULT 0.5,
  query_formulations TEXT,
  status TEXT CHECK(status IN ('open', 'searching', 'resolved', 'stale')),
  resolved_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_gap_signals_status_priority ON gap_signals(status, priority);
