// Core D1 query layer for the Grimoire database
// All SQL lives here. Handle delegates here; handle contains no SQL.

import { QUERY } from '../config'
import {
  fromRow, toRow, fromArrangementRow,
  type GrimoireAtom, type AtomRow,
  type Category, type Collection,
  type Arrangement, type ArrangementRow,
  type ProviderRecommendation,
  type IntegrityScanResult,
} from '../grimoire/types'

// ---------- Lookup ----------

export async function lookupAtom(db: D1Database, term: string): Promise<GrimoireAtom | null> {
  const row = await db.prepare(
    'SELECT * FROM atoms WHERE text_lower = ? LIMIT 1'
  ).bind(term.toLowerCase()).first<AtomRow>()
  return row ? fromRow(row) : null
}

// ---------- Search ----------

function sanitizeFtsQuery(query: string): string {
  // Lowercase FTS5 operators (AND/OR/NOT/NEAR) so they're treated as search terms.
  // This is the safe direction: prevents accidental boolean queries from MCP callers.
  return query
    .replace(/[(){}[\]]/g, '')
    .replace(/"/g, '')
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, (m) => m.toLowerCase())
    .trim()
}

async function ftsSearch(
  db: D1Database,
  query: string,
  opts: { category?: string; collection?: string; modality?: string; status?: string; limit?: number } = {}
): Promise<GrimoireAtom[]> {
  const limit = Math.min(opts.limit ?? QUERY.DEFAULT_SEARCH_LIMIT, QUERY.MAX_SEARCH_LIMIT)
  const safeQuery = sanitizeFtsQuery(query)
  if (!safeQuery) throw new Error('Empty FTS query after sanitization')

  let sql = `
    SELECT a.*, fts.rank
    FROM atoms_fts fts
    JOIN atoms a ON a.rowid = fts.rowid
    WHERE atoms_fts MATCH ?
  `
  const binds: unknown[] = [safeQuery]

  if (opts.category) { sql += ' AND a.category_slug = ?'; binds.push(opts.category) }
  if (opts.collection) { sql += ' AND a.collection_slug = ?'; binds.push(opts.collection) }
  if (opts.modality) { sql += ' AND a.modality = ?'; binds.push(opts.modality) }
  if (opts.status) { sql += ' AND a.status = ?'; binds.push(opts.status) }
  else { sql += " AND a.status != 'rejected'" }

  sql += ' ORDER BY fts.rank LIMIT ?'
  binds.push(limit)

  const result = await db.prepare(sql).bind(...binds).all<AtomRow>()
  return (result.results ?? []).map(fromRow)
}

export async function searchAtoms(
  db: D1Database,
  query: string,
  opts: { category?: string; collection?: string; modality?: string; status?: string; limit?: number } = {}
): Promise<GrimoireAtom[]> {
  // FTS5 first, LIKE fallback
  try {
    return await ftsSearch(db, query, opts)
  } catch (e) {
    console.warn('[search] FTS5 failed, falling back to LIKE:', e)
  }

  const limit = Math.min(opts.limit ?? QUERY.DEFAULT_SEARCH_LIMIT, QUERY.MAX_SEARCH_LIMIT)
  const parts: string[] = ["text_lower LIKE '%' || ? || '%'"]
  const binds: unknown[] = [query.toLowerCase()]

  if (opts.category) { parts.push('category_slug = ?'); binds.push(opts.category) }
  if (opts.collection) { parts.push('collection_slug = ?'); binds.push(opts.collection) }
  if (opts.modality) { parts.push('modality = ?'); binds.push(opts.modality) }
  if (opts.status) { parts.push('status = ?'); binds.push(opts.status) }
  else { parts.push("status != 'rejected'") }

  binds.push(limit)
  const sql = `SELECT * FROM atoms WHERE ${parts.join(' AND ')} ORDER BY confidence DESC, encounter_count DESC LIMIT ?`
  const result = await db.prepare(sql).bind(...binds).all<AtomRow>()
  return (result.results ?? []).map(fromRow)
}

// ---------- Recommend ----------

export async function getRecommendations(
  db: D1Database,
  intent: string,
  arrangementSlug?: string
): Promise<GrimoireAtom[]> {
  if (!arrangementSlug) {
    return searchAtoms(db, intent, { limit: QUERY.DEFAULT_SEARCH_LIMIT })
  }

  const arrRow = await db.prepare(
    'SELECT * FROM arrangements WHERE slug = ?'
  ).bind(arrangementSlug).first<ArrangementRow>()

  if (!arrRow) return searchAtoms(db, intent, { limit: QUERY.DEFAULT_SEARCH_LIMIT })

  const arr = fromArrangementRow(arrRow)
  const weights = arr.category_weights as Record<string, number>
  const topCategories = Object.entries(weights)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([slug]) => slug)

  if (topCategories.length === 0) return searchAtoms(db, intent, { limit: QUERY.DEFAULT_SEARCH_LIMIT })

  const placeholders = topCategories.map(() => '?').join(',')

  // FTS5 first, LIKE fallback
  try {
    const safeIntent = sanitizeFtsQuery(intent)
    if (safeIntent) {
      const ftsResult = await db.prepare(
        `SELECT a.*, fts.rank FROM atoms_fts fts
         JOIN atoms a ON a.rowid = fts.rowid
         WHERE atoms_fts MATCH ? AND a.category_slug IN (${placeholders})
         AND a.status != 'rejected'
         ORDER BY fts.rank LIMIT ?`
      ).bind(safeIntent, ...topCategories, QUERY.DEFAULT_SEARCH_LIMIT).all<AtomRow>()
      const ftsAtoms = (ftsResult.results ?? []).map(fromRow)
      if (ftsAtoms.length > 0) return ftsAtoms
    }
  } catch (e) {
    console.warn('[recommend] FTS5 failed, falling back to LIKE:', e)
  }

  const intentLower = intent.toLowerCase()
  const result = await db.prepare(
    `SELECT * FROM atoms WHERE category_slug IN (${placeholders})
     AND text_lower LIKE '%' || ? || '%' AND status != 'rejected'
     ORDER BY confidence DESC LIMIT ?`
  ).bind(...topCategories, intentLower, QUERY.DEFAULT_SEARCH_LIMIT).all<AtomRow>()

  const atoms = (result.results ?? []).map(fromRow)
  return atoms.length > 0 ? atoms : searchAtoms(db, intent, { limit: QUERY.DEFAULT_SEARCH_LIMIT })
}

// ---------- Routing ----------

export async function getProviderRoute(
  db: D1Database,
  taskType: string
): Promise<ProviderRecommendation> {
  const row = await db.prepare(
    "SELECT * FROM app_routing WHERE task_type = ? OR task_type = 'default' ORDER BY CASE WHEN task_type = ? THEN 0 ELSE 1 END LIMIT 1"
  ).bind(taskType, taskType).first<Record<string, unknown>>()

  if (!row) {
    return { provider: 'gemini', confidence: 0.5, prompt_hint: '', known_failures: [] }
  }

  return {
    provider: (row.provider as ProviderRecommendation['provider']) ?? 'gemini',
    confidence: (row.confidence as number) ?? 0.5,
    prompt_hint: (row.prompt_hint as string) ?? '',
    known_failures: JSON.parse((row.known_failures as string) ?? '[]'),
  }
}

// ---------- Taxonomy ----------

export async function getCategories(db: D1Database): Promise<Category[]> {
  const result = await db.prepare(
    'SELECT slug, parent, label, description, output_schema FROM categories ORDER BY slug'
  ).all<Category>()
  return result.results ?? []
}

export async function getCollections(db: D1Database): Promise<Collection[]> {
  const result = await db.prepare(
    'SELECT slug, name, description, parent_slug FROM collections ORDER BY slug'
  ).all<Collection>()
  return result.results ?? []
}

export async function getArrangements(db: D1Database): Promise<Arrangement[]> {
  const result = await db.prepare(
    'SELECT slug, name, description, harmonics, category_weights, context_key FROM arrangements ORDER BY slug'
  ).all<ArrangementRow>()
  return (result.results ?? []).map(fromArrangementRow)
}

// ---------- Write ----------

export async function insertAtom(db: D1Database, atom: GrimoireAtom): Promise<void> {
  const row = toRow(atom)
  await db.prepare(
    `INSERT INTO atoms (id, text, text_lower, collection_slug, category_slug, observation, status,
     confidence, encounter_count, tags, source, source_app, metadata, harmonics, modality,
     utility, embedding_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    row.id, row.text, row.text_lower, row.collection_slug, row.category_slug ?? null,
    row.observation, row.status, row.confidence, row.encounter_count ?? 1,
    row.tags, row.source, row.source_app ?? null, row.metadata, row.harmonics,
    row.modality, (row as any).utility ?? 'visual', row.embedding_status ?? 'pending',
    row.created_at, row.updated_at
  ).run()
}

// ---------- Checks ----------

export async function checkDuplicate(db: D1Database, textLower: string, collectionSlug: string): Promise<boolean> {
  const row = await db.prepare(
    'SELECT id FROM atoms WHERE text_lower = ? AND collection_slug = ? LIMIT 1'
  ).bind(textLower, collectionSlug).first()
  return row !== null
}

export async function checkCategoryExists(db: D1Database, slug: string): Promise<boolean> {
  const row = await db.prepare('SELECT slug FROM categories WHERE slug = ? LIMIT 1').bind(slug).first()
  return row !== null
}

export async function checkCollectionExists(db: D1Database, slug: string): Promise<boolean> {
  const row = await db.prepare('SELECT slug FROM collections WHERE slug = ? LIMIT 1').bind(slug).first()
  return row !== null
}

// ---------- Health ----------

export async function getAtomCounts(db: D1Database): Promise<Record<string, number>> {
  const result = await db.prepare(
    "SELECT status, COUNT(*) as count FROM atoms GROUP BY status"
  ).all<{ status: string; count: number }>()
  const counts: Record<string, number> = { provisional: 0, confirmed: 0, rejected: 0 }
  for (const row of result.results ?? []) counts[row.status] = row.count
  return counts
}

export async function getProvisionalAtoms(db: D1Database, limit = 50): Promise<GrimoireAtom[]> {
  const result = await db.prepare(
    "SELECT * FROM atoms WHERE status = 'provisional' ORDER BY created_at ASC LIMIT ?"
  ).bind(limit).all<AtomRow>()
  return (result.results ?? []).map(fromRow)
}

export async function getLastScanResult(db: D1Database): Promise<IntegrityScanResult | null> {
  return db.prepare(
    'SELECT * FROM integrity_scans ORDER BY created_at DESC LIMIT 1'
  ).first<IntegrityScanResult>()
}

export async function saveScanResult(
  db: D1Database,
  scanType: IntegrityScanResult['scan_type'],
  atomsScanned: number,
  issues: unknown[],
  durationMs: number
): Promise<void> {
  await db.prepare(
    `INSERT INTO integrity_scans (scan_type, atoms_scanned, issues_found, issues, duration_ms)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(scanType, atomsScanned, issues.length, JSON.stringify(issues), durationMs).run()
}
