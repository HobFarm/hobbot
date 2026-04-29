// SQL layer for atom_relations and provider_behaviors tables
// All SQL for these tables lives here. handle.ts contains zero SQL.

import type {
  AtomRelation, RelatedAtomResult, AddRelationInput,
  ProviderBehavior, ProviderBehaviorInput, ProviderBehaviorQuery,
} from '../grimoire/types'

// ---------- Atom Relations ----------

interface RelationJoinRow {
  relation_id: string
  atom_id: string
  atom_text: string
  atom_collection: string
  atom_category: string | null
  relation_type: string
  strength: number
  context: string | null
  source: string
  confidence: number
  direction: string
}

export async function getRelatedAtoms(
  db: D1Database,
  atomId: string,
  opts: { relation_type?: string; direction?: 'outgoing' | 'incoming' | 'both'; limit?: number } = {}
): Promise<RelatedAtomResult[]> {
  const limit = Math.min(opts.limit ?? 20, 100)
  const direction = opts.direction ?? 'both'

  const unions: string[] = []
  const binds: unknown[] = []

  if (direction === 'outgoing' || direction === 'both') {
    let clause = `SELECT r.id as relation_id, a.id as atom_id, a.text as atom_text,
      a.collection_slug as atom_collection, a.category_slug as atom_category,
      r.relation_type, r.strength, r.context, r.source, r.confidence,
      'outgoing' as direction
      FROM atom_relations r JOIN atoms a ON r.target_atom_id = a.id
      WHERE r.source_atom_id = ?`
    binds.push(atomId)
    if (opts.relation_type) { clause += ' AND r.relation_type = ?'; binds.push(opts.relation_type) }
    unions.push(clause)
  }

  if (direction === 'incoming' || direction === 'both') {
    let clause = `SELECT r.id as relation_id, a.id as atom_id, a.text as atom_text,
      a.collection_slug as atom_collection, a.category_slug as atom_category,
      r.relation_type, r.strength, r.context, r.source, r.confidence,
      'incoming' as direction
      FROM atom_relations r JOIN atoms a ON r.source_atom_id = a.id
      WHERE r.target_atom_id = ?`
    binds.push(atomId)
    if (opts.relation_type) { clause += ' AND r.relation_type = ?'; binds.push(opts.relation_type) }
    unions.push(clause)
  }

  binds.push(limit)
  const sql = `${unions.join(' UNION ALL ')} ORDER BY strength DESC LIMIT ?`
  const result = await db.prepare(sql).bind(...binds).all<RelationJoinRow>()

  return (result.results ?? []).map(row => ({
    relation_id: row.relation_id,
    related_atom: {
      id: row.atom_id,
      text: row.atom_text,
      collection_slug: row.atom_collection,
      category_slug: row.atom_category,
    },
    relation_type: row.relation_type as RelatedAtomResult['relation_type'],
    strength: row.strength,
    context: row.context,
    source: row.source as RelatedAtomResult['source'],
    confidence: row.confidence,
    direction: row.direction as 'outgoing' | 'incoming',
  }))
}

export async function addRelation(
  db: D1Database,
  input: AddRelationInput
): Promise<{ id: string; created: boolean }> {
  const strength = input.strength ?? 0.5
  const context = input.context ?? ''
  const source = input.source ?? 'curated'
  const confidence = input.confidence ?? 0.7
  const id = crypto.randomUUID()

  await db.prepare(
    `INSERT INTO atom_relations (id, source_atom_id, target_atom_id, relation_type, strength, context, source, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_atom_id, target_atom_id, relation_type, context)
     DO UPDATE SET
       strength = MAX(atom_relations.strength, excluded.strength),
       confidence = MAX(atom_relations.confidence, excluded.confidence),
       source = excluded.source,
       updated_at = datetime('now')`
  ).bind(id, input.source_atom_id, input.target_atom_id, input.relation_type, strength, context, source, confidence).run()

  // Detect insert vs update: if our generated id exists, it was a fresh insert.
  // If ON CONFLICT fired, the existing row kept its original id.
  const mine = await db.prepare('SELECT id FROM atom_relations WHERE id = ?').bind(id).first<{ id: string }>()
  if (mine) return { id, created: true }

  const existing = await db.prepare(
    'SELECT id FROM atom_relations WHERE source_atom_id = ? AND target_atom_id = ? AND relation_type = ? AND context = ?'
  ).bind(input.source_atom_id, input.target_atom_id, input.relation_type, context).first<{ id: string }>()
  return { id: existing!.id, created: false }
}

export async function getRelationCounts(db: D1Database): Promise<{ total: number; byType: Record<string, number> }> {
  const result = await db.prepare(
    'SELECT relation_type, COUNT(*) as count FROM atom_relations GROUP BY relation_type'
  ).all<{ relation_type: string; count: number }>()

  const byType: Record<string, number> = {}
  let total = 0
  for (const row of result.results ?? []) {
    byType[row.relation_type] = row.count
    total += row.count
  }
  return { total, byType }
}

// ---------- Provider Behaviors ----------

export async function queryProviderBehaviors(
  db: D1Database,
  query: ProviderBehaviorQuery = {}
): Promise<ProviderBehavior[]> {
  const parts: string[] = []
  const binds: unknown[] = []

  if (query.provider) { parts.push('provider = ?'); binds.push(query.provider) }
  if (query.atom_id) { parts.push('atom_id = ?'); binds.push(query.atom_id) }
  if (query.atom_category) { parts.push('atom_category = ?'); binds.push(query.atom_category) }
  if (query.render_mode) { parts.push('render_mode = ?'); binds.push(query.render_mode) }
  if (query.severity) { parts.push('severity = ?'); binds.push(query.severity) }

  const where = parts.length > 0 ? `WHERE ${parts.join(' AND ')}` : ''
  const sql = `SELECT * FROM provider_behaviors ${where} ORDER BY observed_at DESC LIMIT 100`
  const result = await db.prepare(sql).bind(...binds).all<ProviderBehavior>()
  return result.results ?? []
}

export async function insertProviderBehavior(
  db: D1Database,
  input: ProviderBehaviorInput
): Promise<{ id: string }> {
  const id = crypto.randomUUID()
  await db.prepare(
    `INSERT INTO provider_behaviors (id, provider, atom_id, atom_category, behavior, render_mode, severity)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, input.provider,
    input.atom_id ?? null,
    input.atom_category ?? null,
    input.behavior,
    input.render_mode ?? null,
    input.severity ?? 'info'
  ).run()
  return { id }
}

export async function getProviderBehaviorCounts(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) as count FROM provider_behaviors').first<{ count: number }>()
  return row?.count ?? 0
}
