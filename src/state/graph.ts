// SQL layer for Phase 1 graph tables: correspondences, exemplars, incantations, category_relations
// All SQL for these tables lives here. handle.ts contains zero SQL.

import { fromRow } from '../grimoire/types'
import type {
  GrimoireAtom, AtomRow,
  Correspondence, CorrespondenceQueryOptions, CorrespondenceStats,
  Exemplar, Incantation, IncantationSlot, CategoryRelation,
} from '../grimoire/types'

function safeJson<T>(val: string | null | undefined, fallback: T): T {
  if (!val) return fallback
  try { return JSON.parse(val) as T } catch { return fallback }
}

// ---------- Correspondence Row Types ----------

interface CorrespondenceRow extends Omit<Correspondence, 'metadata'> {
  metadata: string
}

interface ExemplarRow extends Omit<Exemplar, 'metadata'> {
  metadata: string
}

interface IncantationRow extends Omit<Incantation, 'metadata' | 'slots'> {
  metadata: string
}

// SQLite stores booleans as 0|1
interface IncantationSlotRow extends Omit<IncantationSlot, 'required'> {
  required: number | boolean
}

// ---------- Correspondences ----------

export async function getCorrespondencesForAtom(
  db: D1Database,
  atomId: string,
  opts: CorrespondenceQueryOptions = {}
): Promise<Correspondence[]> {
  const limit = opts.limit ?? 50
  const parts: string[] = ['(atom_a_id = ? OR atom_b_id = ?)']
  const binds: unknown[] = [atomId, atomId]

  if (opts.relationship_type) { parts.push('relationship_type = ?'); binds.push(opts.relationship_type) }
  if (opts.provenance) { parts.push('provenance = ?'); binds.push(opts.provenance) }
  if (opts.min_strength !== undefined) { parts.push('strength >= ?'); binds.push(opts.min_strength) }
  if (opts.arrangement_scope !== undefined) {
    parts.push('arrangement_scope = ?'); binds.push(opts.arrangement_scope)
  }

  binds.push(limit)
  const sql = `SELECT * FROM correspondences WHERE ${parts.join(' AND ')} ORDER BY strength DESC LIMIT ?`
  const result = await db.prepare(sql).bind(...binds).all<CorrespondenceRow>()
  return (result.results ?? []).map(row => ({ ...row, metadata: safeJson(row.metadata, {}) }))
}

// ---------- Exemplars ----------

export async function getExemplarsForAtom(db: D1Database, atomId: string): Promise<Exemplar[]> {
  const result = await db.prepare(
    `SELECT e.*, i.name as incantation_name
     FROM exemplars e JOIN incantations i ON e.incantation_id = i.id
     WHERE e.atom_id = ? ORDER BY e.frequency DESC`
  ).bind(atomId).all<ExemplarRow>()
  return (result.results ?? []).map(row => ({ ...row, metadata: safeJson(row.metadata, {}) }))
}

export async function getExemplarCount(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) as count FROM exemplars').first<{ count: number }>()
  return row?.count ?? 0
}

// ---------- Incantations ----------

export async function getIncantations(db: D1Database): Promise<Incantation[]> {
  const incResult = await db.prepare('SELECT * FROM incantations ORDER BY name').all<IncantationRow>()
  const rows = incResult.results ?? []
  if (rows.length === 0) return []

  const ids = rows.map(r => r.id)
  const placeholders = ids.map(() => '?').join(',')
  const slotResult = await db.prepare(
    `SELECT * FROM incantation_slots WHERE incantation_id IN (${placeholders}) ORDER BY sort_order`
  ).bind(...ids).all<IncantationSlotRow>()

  const slotMap = new Map<string, IncantationSlot[]>()
  for (const s of slotResult.results ?? []) {
    const list = slotMap.get(s.incantation_id) ?? []
    list.push({ ...s, required: Boolean(s.required) })
    slotMap.set(s.incantation_id, list)
  }

  return rows.map(row => ({
    ...row,
    metadata: safeJson(row.metadata, {}),
    slots: slotMap.get(row.id) ?? [],
  }))
}

export async function getIncantationBySlug(db: D1Database, slug: string): Promise<Incantation | null> {
  const row = await db.prepare('SELECT * FROM incantations WHERE slug = ?').bind(slug).first<IncantationRow>()
  if (!row) return null

  const slotsResult = await db.prepare(
    'SELECT * FROM incantation_slots WHERE incantation_id = ? ORDER BY sort_order'
  ).bind(row.id).all<IncantationSlotRow>()

  return {
    ...row,
    metadata: safeJson(row.metadata, {}),
    slots: (slotsResult.results ?? []).map(s => ({ ...s, required: Boolean(s.required) })),
  }
}

export async function getIncantationCount(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) as count FROM incantations').first<{ count: number }>()
  return row?.count ?? 0
}

// ---------- Category Relations ----------

export async function getCategoryRelations(db: D1Database, slug?: string): Promise<CategoryRelation[]> {
  if (slug) {
    const result = await db.prepare(
      'SELECT * FROM category_relations WHERE source_slug = ? OR target_slug = ?'
    ).bind(slug, slug).all<CategoryRelation>()
    return result.results ?? []
  }
  const result = await db.prepare('SELECT * FROM category_relations ORDER BY source_slug').all<CategoryRelation>()
  return result.results ?? []
}

// ---------- Stats ----------

export async function getCorrespondenceStats(db: D1Database): Promise<CorrespondenceStats> {
  const result = await db.prepare(
    'SELECT relationship_type, provenance, COUNT(*) as count FROM correspondences GROUP BY relationship_type, provenance'
  ).all<{ relationship_type: string; provenance: string; count: number }>()

  const byType: Record<string, number> = {}
  const byProvenance: Record<string, number> = {}
  let total = 0

  for (const row of result.results ?? []) {
    byType[row.relationship_type] = (byType[row.relationship_type] ?? 0) + row.count
    byProvenance[row.provenance] = (byProvenance[row.provenance] ?? 0) + row.count
    total += row.count
  }

  return { byType, byProvenance, total }
}

// ---------- Orphaned Atoms ----------

export async function getOrphanedAtoms(db: D1Database, limit = 100): Promise<GrimoireAtom[]> {
  const result = await db.prepare(
    `SELECT a.* FROM atoms a
     LEFT JOIN correspondences c ON a.id = c.atom_a_id OR a.id = c.atom_b_id
     WHERE c.id IS NULL AND a.status = 'provisional' AND a.embedding_status = 'complete'
     LIMIT ?`
  ).bind(limit).all<AtomRow>()
  return (result.results ?? []).map(fromRow)
}
