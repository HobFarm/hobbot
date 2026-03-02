-- Knowledge Ingest Pipeline: ingest log
-- Tracks URL ingestion attempts, prevents re-processing, stores extraction results

CREATE TABLE ingest_log (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('aesthetic', 'domain')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'complete', 'failed')),
  atoms_created INTEGER DEFAULT 0,
  atoms_skipped INTEGER DEFAULT 0,
  relations_created INTEGER DEFAULT 0,
  extraction_json TEXT,
  error_message TEXT,
  dry_run INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE UNIQUE INDEX idx_ingest_log_url ON ingest_log(url);
CREATE INDEX idx_ingest_log_status ON ingest_log(status);
CREATE INDEX idx_ingest_log_created ON ingest_log(created_at);
