-- Expand feed_entries.extraction_status CHECK constraint.
-- Writer at workers/hobbot-pipeline/src/services/rss-ingest-queue.ts
-- writes 'processing' (claim-on-start, line 47) and 'complete' (success
-- markers, lines 57 and 77). Neither was in the original CHECK set,
-- causing every 6h rss-ingest cron tick to fail with
-- "D1_ERROR: CHECK constraint failed: extraction_status".
--
-- SQLite cannot ALTER CHECK in place. Table rebuild preserves all
-- columns added by 0006_feed_enhancements.sql and 0013_knowledge_agent_swarm.sql,
-- plus all indexes. D1 wraps each migration in its own transaction
-- automatically, so no explicit BEGIN/COMMIT here.

CREATE TABLE feed_entries_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES sources(id),
  entry_url TEXT NOT NULL,
  entry_title TEXT,
  published_at TEXT,
  fetched_at TEXT DEFAULT (datetime('now')),
  extraction_status TEXT CHECK(extraction_status IN ('pending', 'processing', 'extracted', 'complete', 'failed', 'no_terms')),
  extracted_terms TEXT,
  relevance_score REAL,
  content_hash TEXT,
  ingested INTEGER NOT NULL DEFAULT 0,
  grimoire_source_id TEXT,
  ingested_at TEXT,
  scored_at TEXT,
  mime_type TEXT,
  source_type TEXT,
  metadata TEXT,
  knowledge_request_id INTEGER REFERENCES knowledge_requests(id),
  UNIQUE(source_id, entry_url)
);

INSERT INTO feed_entries_new (
  id, source_id, entry_url, entry_title, published_at, fetched_at,
  extraction_status, extracted_terms, relevance_score, content_hash,
  ingested, grimoire_source_id, ingested_at, scored_at, mime_type,
  source_type, metadata, knowledge_request_id
)
SELECT
  id, source_id, entry_url, entry_title, published_at, fetched_at,
  extraction_status, extracted_terms, relevance_score, content_hash,
  ingested, grimoire_source_id, ingested_at, scored_at, mime_type,
  source_type, metadata, knowledge_request_id
FROM feed_entries;

DROP TABLE feed_entries;
ALTER TABLE feed_entries_new RENAME TO feed_entries;

CREATE INDEX idx_feed_entries_hash ON feed_entries(content_hash);
CREATE INDEX idx_feed_entries_ingested ON feed_entries(ingested);
CREATE INDEX idx_feed_entries_kr ON feed_entries(knowledge_request_id);
CREATE INDEX idx_feed_entries_relevance ON feed_entries(relevance_score);
CREATE INDEX idx_feed_entries_source_status ON feed_entries(source_id, extraction_status);
