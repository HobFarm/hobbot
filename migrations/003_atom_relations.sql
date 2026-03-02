-- Knowledge Layer Step 2: atom_relations and provider_behaviors
-- Do NOT touch existing tables: atoms, correspondences, exemplars, incantations,
-- incantation_slots, category_relations, documents, document_chunks, discovery_queue

CREATE TABLE atom_relations (
  id TEXT PRIMARY KEY,
  source_atom_id TEXT NOT NULL,
  target_atom_id TEXT NOT NULL,
  relation_type TEXT NOT NULL CHECK(relation_type IN ('compositional', 'oppositional', 'hierarchical', 'modifies', 'co_occurs', 'derives_from')),
  strength REAL DEFAULT 0.5,
  context TEXT,
  source TEXT DEFAULT 'inferred' CHECK(source IN ('curated', 'discovered', 'inferred', 'observed')),
  confidence REAL DEFAULT 0.5,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (source_atom_id) REFERENCES atoms(id),
  FOREIGN KEY (target_atom_id) REFERENCES atoms(id)
);

CREATE INDEX idx_relations_source ON atom_relations(source_atom_id);
CREATE INDEX idx_relations_target ON atom_relations(target_atom_id);
CREATE INDEX idx_relations_type ON atom_relations(relation_type);
CREATE UNIQUE INDEX idx_relations_pair ON atom_relations(source_atom_id, target_atom_id, relation_type, context);

CREATE TABLE provider_behaviors (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  atom_id TEXT,
  atom_category TEXT,
  behavior TEXT NOT NULL,
  render_mode TEXT,
  severity TEXT DEFAULT 'info' CHECK(severity IN ('info', 'warning', 'breaking')),
  observed_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (atom_id) REFERENCES atoms(id)
);

CREATE INDEX idx_pb_provider ON provider_behaviors(provider);
CREATE INDEX idx_pb_atom ON provider_behaviors(atom_id);
CREATE INDEX idx_pb_render_mode ON provider_behaviors(render_mode);
