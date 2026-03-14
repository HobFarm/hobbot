-- Extend CHECK constraints on atom_relations to support harvester relationship types
-- Adds: narrower_than, influenced_by to relation_type; harvested to source
-- D1/SQLite requires table recreation to modify CHECK constraints

CREATE TABLE atom_relations_new (
  id TEXT PRIMARY KEY,
  source_atom_id TEXT NOT NULL,
  target_atom_id TEXT NOT NULL,
  relation_type TEXT NOT NULL CHECK(relation_type IN (
    'compositional', 'oppositional', 'hierarchical', 'modifies', 'co_occurs', 'derives_from',
    'narrower_than', 'influenced_by'
  )),
  strength REAL DEFAULT 0.5,
  context TEXT,
  source TEXT DEFAULT 'inferred' CHECK(source IN ('curated', 'discovered', 'inferred', 'observed', 'harvested')),
  confidence REAL DEFAULT 0.5,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (source_atom_id) REFERENCES atoms(id),
  FOREIGN KEY (target_atom_id) REFERENCES atoms(id)
);

INSERT INTO atom_relations_new SELECT * FROM atom_relations;

DROP TABLE atom_relations;

ALTER TABLE atom_relations_new RENAME TO atom_relations;

CREATE INDEX idx_relations_source ON atom_relations(source_atom_id);
CREATE INDEX idx_relations_target ON atom_relations(target_atom_id);
CREATE INDEX idx_relations_type ON atom_relations(relation_type);
CREATE UNIQUE INDEX idx_relations_pair ON atom_relations(source_atom_id, target_atom_id, relation_type, context);
