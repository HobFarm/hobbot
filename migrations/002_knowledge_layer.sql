-- Knowledge Layer: documents, document_chunks, discovery_queue

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  mime_type TEXT NOT NULL,
  r2_key TEXT,
  source_url TEXT,
  tags TEXT DEFAULT '[]',
  token_count INTEGER,
  chunk_count INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'chunking', 'chunked', 'failed')),
  source_app TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_documents_status ON documents(status);
CREATE INDEX idx_documents_mime ON documents(mime_type);
CREATE INDEX idx_documents_source_app ON documents(source_app);

CREATE TABLE document_chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  summary TEXT,
  token_count INTEGER,
  category_slug TEXT,
  arrangement_slugs TEXT DEFAULT '[]',
  metadata TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_chunks_document ON document_chunks(document_id);
CREATE INDEX idx_chunks_category ON document_chunks(category_slug);
CREATE INDEX idx_chunks_content ON document_chunks(content);

CREATE TABLE discovery_queue (
  id TEXT PRIMARY KEY,
  term TEXT NOT NULL,
  ir_slot TEXT,
  arrangement_slug TEXT,
  source_app TEXT NOT NULL,
  source_context TEXT DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'accepted', 'rejected', 'merged')),
  resolution_note TEXT,
  resolved_atom_id TEXT,
  duplicate_of_atom_id TEXT,
  suggested_category TEXT,
  suggested_collection TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE INDEX idx_discovery_status ON discovery_queue(status);
CREATE INDEX idx_discovery_term ON discovery_queue(term);
CREATE INDEX idx_discovery_source ON discovery_queue(source_app);
CREATE INDEX idx_discovery_created ON discovery_queue(created_at);
