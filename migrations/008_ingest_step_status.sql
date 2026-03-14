-- Track per-step completion status in ingest_log for partial failure recovery
ALTER TABLE ingest_log ADD COLUMN step_status TEXT DEFAULT NULL;
