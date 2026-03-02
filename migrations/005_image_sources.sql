-- Sources: reference images, moodboards, and other visual media
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('moodboard', 'reference', 'generation', 'document')),
  filename TEXT,
  mime_type TEXT,
  r2_key TEXT,
  source_url TEXT,
  metadata TEXT DEFAULT '{}',
  aesthetic_tags TEXT DEFAULT '[]',
  arrangement_matches TEXT DEFAULT '[]',
  harmonic_profile TEXT DEFAULT '{}',
  atom_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sources_type ON sources(type);

-- Junction: which atoms were extracted from which sources
CREATE TABLE IF NOT EXISTS source_atoms (
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  atom_id TEXT NOT NULL REFERENCES atoms(id) ON DELETE CASCADE,
  confidence REAL DEFAULT 1.0,
  extraction_method TEXT DEFAULT 'gemini_vision',
  PRIMARY KEY (source_id, atom_id)
);

CREATE INDEX IF NOT EXISTS idx_source_atoms_source ON source_atoms(source_id);
CREATE INDEX IF NOT EXISTS idx_source_atoms_atom ON source_atoms(atom_id);
