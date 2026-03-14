-- Extend feed_entries with relevance scoring and Grimoire ingestion tracking.
-- Adds columns needed for the RSS harvester's scoring and ingest pipeline.

ALTER TABLE feed_entries ADD COLUMN relevance_score REAL;
ALTER TABLE feed_entries ADD COLUMN content_hash TEXT;
ALTER TABLE feed_entries ADD COLUMN ingested INTEGER NOT NULL DEFAULT 0;
ALTER TABLE feed_entries ADD COLUMN grimoire_source_id TEXT;
ALTER TABLE feed_entries ADD COLUMN ingested_at TEXT;
ALTER TABLE feed_entries ADD COLUMN scored_at TEXT;

CREATE INDEX idx_feed_entries_relevance ON feed_entries(relevance_score);
CREATE INDEX idx_feed_entries_ingested ON feed_entries(ingested);
CREATE INDEX idx_feed_entries_hash ON feed_entries(content_hash);
