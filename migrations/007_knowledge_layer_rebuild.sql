-- Knowledge Layer Rebuild: extend sources, source_atoms, documents, ingest_log
-- for full provenance chain: source -> document -> chunks -> atoms -> source_atoms

-- sources: knowledge ingest provenance
ALTER TABLE sources ADD COLUMN content_type TEXT;
ALTER TABLE sources ADD COLUMN document_id TEXT;
ALTER TABLE sources ADD COLUMN status TEXT DEFAULT 'pending';
ALTER TABLE sources ADD COLUMN extraction_model TEXT;
ALTER TABLE sources ADD COLUMN extraction_prompt_version TEXT;
CREATE INDEX IF NOT EXISTS idx_sources_content_type ON sources(content_type);
CREATE INDEX IF NOT EXISTS idx_sources_status ON sources(status);
CREATE INDEX IF NOT EXISTS idx_sources_document ON sources(document_id);

-- source_atoms: chunk provenance
ALTER TABLE source_atoms ADD COLUMN extraction_context TEXT;
ALTER TABLE source_atoms ADD COLUMN chunk_id TEXT;
CREATE INDEX IF NOT EXISTS idx_source_atoms_chunk ON source_atoms(chunk_id);

-- documents: back-link to source
ALTER TABLE documents ADD COLUMN source_id TEXT;
CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source_id);

-- ingest_log: link to source + document
ALTER TABLE ingest_log ADD COLUMN source_id TEXT;
ALTER TABLE ingest_log ADD COLUMN document_id TEXT;
ALTER TABLE ingest_log ADD COLUMN chunks_created INTEGER DEFAULT 0;
