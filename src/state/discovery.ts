// SQL layer for Knowledge Layer: discovery_queue
// All SQL for this table lives here.

import {
  fromDiscoveryRow,
  type DiscoveryEntry, type DiscoveryEntryRow,
  type ResolveOptions, type ResolveResult,
} from '../grimoire/types'
import { ingestAtom } from '../grimoire/ingest'

// ---------- Submit ----------

export async function submitDiscovery(
  db: D1Database,
  entry: Omit<DiscoveryEntry, 'status' | 'resolved_atom_id' | 'duplicate_of_atom_id' | 'resolution_note' | 'resolved_at' | 'created_at'>
): Promise<DiscoveryEntry> {
  await db.prepare(
    `INSERT INTO discovery_queue
     (id, term, ir_slot, arrangement_slug, source_app, source_context,
      suggested_category, suggested_collection, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))`
  ).bind(
    entry.id, entry.term, entry.ir_slot ?? null, entry.arrangement_slug ?? null,
    entry.source_app, JSON.stringify(entry.source_context ?? {}),
    entry.suggested_category ?? null, entry.suggested_collection ?? null
  ).run()

  const row = await db.prepare(
    'SELECT * FROM discovery_queue WHERE id = ?'
  ).bind(entry.id).first<DiscoveryEntryRow>()

  return fromDiscoveryRow(row!)
}

// ---------- List ----------

export async function listDiscoveries(
  db: D1Database,
  opts: { status?: string; source_app?: string; limit?: number } = {}
): Promise<DiscoveryEntry[]> {
  const limit = Math.min(opts.limit ?? 50, 200)
  const parts: string[] = []
  const binds: unknown[] = []

  // Default to pending if no status specified
  if (opts.status) { parts.push('status = ?'); binds.push(opts.status) }

  if (opts.source_app) { parts.push('source_app = ?'); binds.push(opts.source_app) }

  binds.push(limit)
  const where = parts.length > 0 ? `WHERE ${parts.join(' AND ')}` : ''
  const sql = `SELECT * FROM discovery_queue ${where} ORDER BY created_at DESC LIMIT ?`
  const result = await db.prepare(sql).bind(...binds).all<DiscoveryEntryRow>()
  return (result.results ?? []).map(fromDiscoveryRow)
}

// ---------- Resolve ----------

export async function resolveDiscovery(
  db: D1Database,
  id: string,
  resolution: ResolveOptions
): Promise<ResolveResult> {
  // Fetch the queue entry
  const row = await db.prepare(
    'SELECT * FROM discovery_queue WHERE id = ?'
  ).bind(id).first<DiscoveryEntryRow>()

  if (!row) {
    throw new Error(`Discovery entry '${id}' not found`)
  }

  const entry = fromDiscoveryRow(row)

  if (entry.status !== 'pending') {
    throw new Error(`Discovery entry '${id}' is already ${entry.status}`)
  }

  const now = new Date().toISOString()

  if (resolution.action === 'accept') {
    if (!resolution.collection_slug) {
      throw new Error("'accept' action requires collection_slug")
    }

    // Call ingestAtom to create the atom. If validation fails, keep entry pending.
    const ingestResult = await ingestAtom(db, {
      text: entry.term,
      collection_slug: resolution.collection_slug,
      category_slug: resolution.category_slug ?? entry.suggested_category ?? undefined,
      observation: resolution.observation ?? 'observation',
      confidence: resolution.confidence ?? 0.7,
      harmonics: resolution.harmonics ?? {},
      source: 'ai',
      source_app: entry.source_app,
    })

    if (!ingestResult.atom) {
      // Validation failed. Return errors, keep entry pending.
      return { queue_entry: entry, validation: ingestResult.validation }
    }

    // Atom created. Update queue entry.
    await db.prepare(
      `UPDATE discovery_queue
       SET status = 'accepted', resolved_atom_id = ?, resolution_note = ?, resolved_at = ?
       WHERE id = ?`
    ).bind(ingestResult.atom.id, resolution.note ?? null, now, id).run()

    return {
      atom: ingestResult.atom,
      queue_entry: { ...entry, status: 'accepted', resolved_atom_id: ingestResult.atom.id, resolution_note: resolution.note ?? null, resolved_at: now },
    }
  }

  if (resolution.action === 'reject') {
    await db.prepare(
      `UPDATE discovery_queue
       SET status = 'rejected', resolution_note = ?, resolved_at = ?
       WHERE id = ?`
    ).bind(resolution.note ?? null, now, id).run()

    return {
      queue_entry: { ...entry, status: 'rejected', resolution_note: resolution.note ?? null, resolved_at: now },
    }
  }

  if (resolution.action === 'merge') {
    if (!resolution.duplicate_of_atom_id) {
      throw new Error("'merge' action requires duplicate_of_atom_id")
    }

    await db.prepare(
      `UPDATE discovery_queue
       SET status = 'merged', duplicate_of_atom_id = ?, resolution_note = ?, resolved_at = ?
       WHERE id = ?`
    ).bind(resolution.duplicate_of_atom_id, resolution.note ?? null, now, id).run()

    return {
      queue_entry: {
        ...entry,
        status: 'merged',
        duplicate_of_atom_id: resolution.duplicate_of_atom_id,
        resolution_note: resolution.note ?? null,
        resolved_at: now,
      },
    }
  }

  throw new Error(`Unknown resolution action: ${resolution.action}`)
}

// ---------- Counts (for stats) ----------

export async function getDiscoveryQueueCounts(
  db: D1Database
): Promise<Record<string, number>> {
  const result = await db.prepare(
    'SELECT status, COUNT(*) as count FROM discovery_queue GROUP BY status'
  ).all<{ status: string; count: number }>()
  const counts: Record<string, number> = { pending: 0, accepted: 0, rejected: 0, merged: 0 }
  for (const row of result.results ?? []) counts[row.status] = row.count
  return counts
}
