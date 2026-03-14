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
  content_type: string | null
  document_id: string | null
  status: string | null
  extraction_model: string | null
  extraction_prompt_version: string | null
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
    content_type: row.content_type ?? null,
    document_id: row.document_id ?? null,
    status: row.status ?? null,
    extraction_model: row.extraction_model ?? null,
    extraction_prompt_version: row.extraction_prompt_version ?? null,
  }
}

const VALID_SOURCE_TYPES = new Set([
  'moodboard', 'reference', 'generation', 'document',
  'film', 'dataset', 'feed_item', 'api_entry', 'external',
])

// ---- Insert ----

export async function insertSource(db: D1Database, source: SourceRecord): Promise<void> {
  if (!VALID_SOURCE_TYPES.has(source.type)) {
    throw new Error(`Invalid source type: ${source.type}`)
  }
  await db.prepare(
    `INSERT INTO sources (id, type, filename, mime_type, r2_key, source_url, metadata, aesthetic_tags,
     arrangement_matches, harmonic_profile, atom_count, created_at, content_type, document_id, status,
     extraction_model, extraction_prompt_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    source.content_type ?? null,
    source.document_id ?? null,
    source.status ?? null,
    source.extraction_model ?? null,
    source.extraction_prompt_version ?? null,
  ).run()

  // Dual-write: arrangement_sources join table
  const matches = source.arrangement_matches ?? []
  if (matches.length > 0) {
    try {
      const stmts = matches.map(m =>
        db.prepare(
          'INSERT OR IGNORE INTO arrangement_sources (arrangement_slug, source_id, confidence) VALUES (?, ?, ?)'
        ).bind(m.slug, source.id, m.confidence ?? 0)
      )
      await db.batch(stmts)
    } catch (e) {
      console.warn(`[sources] arrangement_sources dual-write failed for source ${source.id}: ${e instanceof Error ? e.message : e}`)
    }
  }
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

export async function updateSourceStatus(db: D1Database, id: string, status: string): Promise<void> {
  await db.prepare('UPDATE sources SET status = ? WHERE id = ?').bind(status, id).run()
}

export async function updateSourceExtraction(
  db: D1Database,
  id: string,
  info: {
    extraction_model?: string
    extraction_prompt_version?: string
    harmonic_profile?: Record<string, string>
    arrangement_matches?: { slug: string; confidence: number; reasoning?: string }[]
    aesthetic_tags?: string[]
    atom_count?: number
    status?: string
    document_id?: string
  }
): Promise<void> {
  const sets: string[] = []
  const binds: unknown[] = []

  if (info.extraction_model !== undefined) { sets.push('extraction_model = ?'); binds.push(info.extraction_model) }
  if (info.extraction_prompt_version !== undefined) { sets.push('extraction_prompt_version = ?'); binds.push(info.extraction_prompt_version) }
  if (info.harmonic_profile !== undefined) { sets.push('harmonic_profile = ?'); binds.push(JSON.stringify(info.harmonic_profile)) }
  if (info.arrangement_matches !== undefined) { sets.push('arrangement_matches = ?'); binds.push(JSON.stringify(info.arrangement_matches)) }
  if (info.aesthetic_tags !== undefined) { sets.push('aesthetic_tags = ?'); binds.push(JSON.stringify(info.aesthetic_tags)) }
  if (info.atom_count !== undefined) { sets.push('atom_count = ?'); binds.push(info.atom_count) }
  if (info.status !== undefined) { sets.push('status = ?'); binds.push(info.status) }
  if (info.document_id !== undefined) { sets.push('document_id = ?'); binds.push(info.document_id) }

  if (sets.length === 0) return
  binds.push(id)
  await db.prepare(`UPDATE sources SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run()

  // Dual-write: update arrangement_sources join table when matches change
  if (info.arrangement_matches !== undefined) {
    try {
      const stmts: D1PreparedStatement[] = [
        db.prepare('DELETE FROM arrangement_sources WHERE source_id = ?').bind(id),
      ]
      for (const m of info.arrangement_matches) {
        stmts.push(
          db.prepare(
            'INSERT OR IGNORE INTO arrangement_sources (arrangement_slug, source_id, confidence) VALUES (?, ?, ?)'
          ).bind(m.slug, id, m.confidence ?? 0)
        )
      }
      await db.batch(stmts)
    } catch (e) {
      console.warn(`[sources] arrangement_sources dual-write (update) failed for source ${id}: ${e instanceof Error ? e.message : e}`)
    }
  }
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

export async function insertSourceAtomWithContext(
  db: D1Database,
  sourceId: string,
  atomId: string,
  confidence: number,
  method: string,
  extractionContext: string | null,
  chunkId: string | null
): Promise<void> {
  await db.prepare(
    `INSERT OR IGNORE INTO source_atoms (source_id, atom_id, confidence, extraction_method, extraction_context, chunk_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(sourceId, atomId, confidence, method, extractionContext, chunkId).run()
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
