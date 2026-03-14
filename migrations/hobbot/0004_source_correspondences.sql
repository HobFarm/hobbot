-- Track which metadata relationships have been processed into atom_relations
-- Unmatched rows are gap signals for the triangulation engine

CREATE TABLE source_correspondences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL,
  atom_id TEXT NOT NULL,
  target_atom_text TEXT NOT NULL,
  target_atom_id TEXT,
  relationship_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'matched', 'unmatched', 'created')) DEFAULT 'pending',
  correspondence_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(source_id, atom_id, target_atom_text, relationship_type)
);

CREATE INDEX idx_sc_source_status ON source_correspondences(source_id, status);
CREATE INDEX idx_sc_atom ON source_correspondences(atom_id);
