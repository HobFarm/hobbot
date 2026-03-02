// SQL layer for sources and source_atoms tables
// All database operations for image ingest provenance tracking

import { safeJson, type SourceRecord } from '../grimoire/types'

interface SourceRow {
  id: string
  type: string
  filename: string | null
  mime_type: string | null
  r2_key: string | null
  source_url: string | null
  metadata: string
  aesthetic_tags: string
  arrangement_matches: string
  harmonic_profile: string
  atom_count: number
  created_at: string
}

function fromSourceRow(row: SourceRow): SourceRecord {
  return {
    id: row.id,
    type: row.type as SourceRecord['type'],
    filename: row.filename,
    mime_type: row.mime_type,
    r2_key: row.r2_key,
    source_url: row.source_url,
    metadata: safeJson(row.metadata, {}),
    aesthetic_tags: safeJson(row.aesthetic_tags, []),
    arrangement_matches: safeJson(row.arrangement_matches, []),
    harmonic_profile: safeJson(row.harmonic_profile, {}),
    atom_count: row.atom_count,
    created_at: row.created_at,
  }
}

// ---- Insert ----

export async function insertSource(db: D1Database, source: SourceRecord): Promise<void> {
  await db.prepare(
    `INSERT INTO sources (id, type, filename, mime_type, r2_key, source_url, metadata, aesthetic_tags, arrangement_matches, harmonic_profile, atom_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    source.id,
    source.type,
    source.filename,
    source.mime_type,
    source.r2_key,
    source.source_url,
    JSON.stringify(source.metadata),
    JSON.stringify(source.aesthetic_tags),
    JSON.stringify(source.arrangement_matches),
    JSON.stringify(source.harmonic_profile),
    source.atom_count,
    source.created_at ?? new Date().toISOString(),
  ).run()
}

// ---- Read ----

export async function getSource(db: D1Database, id: string): Promise<SourceRecord | null> {
  const row = await db.prepare('SELECT * FROM sources WHERE id = ? LIMIT 1').bind(id).first<SourceRow>()
  return row ? fromSourceRow(row) : null
}

export async function listSources(
  db: D1Database,
  opts?: { type?: string; limit?: number }
): Promise<SourceRecord[]> {
  const limit = Math.min(opts?.limit ?? 20, 100)
  let sql = 'SELECT * FROM sources'
  const binds: unknown[] = []

  if (opts?.type) {
    sql += ' WHERE type = ?'
    binds.push(opts.type)
  }

  sql += ' ORDER BY created_at DESC LIMIT ?'
  binds.push(limit)

  const result = await db.prepare(sql).bind(...binds).all<SourceRow>()
  return (result.results ?? []).map(fromSourceRow)
}

// ---- Update ----

export async function updateSourceAtomCount(db: D1Database, id: string, count: number): Promise<void> {
  await db.prepare('UPDATE sources SET atom_count = ? WHERE id = ?').bind(count, id).run()
}

// ---- Junction: source_atoms ----

export async function insertSourceAtom(
  db: D1Database,
  sourceId: string,
  atomId: string,
  confidence: number,
  method: string
): Promise<void> {
  await db.prepare(
    `INSERT OR IGNORE INTO source_atoms (source_id, atom_id, confidence, extraction_method)
     VALUES (?, ?, ?, ?)`
  ).bind(sourceId, atomId, confidence, method).run()
}

export async function getSourceAtoms(
  db: D1Database,
  sourceId: string
): Promise<{ atom_id: string; confidence: number; extraction_method: string }[]> {
  const result = await db.prepare(
    'SELECT atom_id, confidence, extraction_method FROM source_atoms WHERE source_id = ?'
  ).bind(sourceId).all<{ atom_id: string; confidence: number; extraction_method: string }>()
  return result.results ?? []
}
