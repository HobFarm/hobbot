-- Memory knowledge: unified knowledge store with confidence lifecycle
CREATE TABLE IF NOT EXISTS memory_knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  knowledge_type TEXT NOT NULL,
  knowledge_key TEXT NOT NULL,
  content TEXT NOT NULL,
  structured_data TEXT,
  confidence REAL DEFAULT 0.3,
  evidence_count INTEGER DEFAULT 1,
  first_created_at TEXT NOT NULL,
  last_updated_at TEXT NOT NULL,
  last_evidence_at TEXT NOT NULL,
  decay_applied_at TEXT,
  UNIQUE(knowledge_type, knowledge_key)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_type_confidence ON memory_knowledge(knowledge_type, confidence DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_last_evidence ON memory_knowledge(last_evidence_at ASC);
