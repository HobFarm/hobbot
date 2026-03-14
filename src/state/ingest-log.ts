// SQL layer for knowledge ingest pipeline log

import { fromIngestLogRow } from '../grimoire/types'
import type { IngestLog, IngestLogRow } from '../grimoire/types'

export async function insertIngestLog(
  db: D1Database,
  log: Omit<IngestLog, 'created_at' | 'completed_at'>
): Promise<void> {
  await db.prepare(
    `INSERT INTO ingest_log (id, url, source_type, status, atoms_created, atoms_skipped,
     relations_created, extraction_json, error_message, dry_run, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).bind(
    log.id,
    log.url,
    log.source_type,
    log.status,
    log.atoms_created,
    log.atoms_skipped,
    log.relations_created,
    log.extraction_json ? JSON.stringify(log.extraction_json) : null,
    log.error_message ?? null,
    log.dry_run ? 1 : 0
  ).run()
}

export async function getIngestLogByUrl(
  db: D1Database,
  url: string
): Promise<IngestLog | null> {
  const row = await db.prepare(
    'SELECT * FROM ingest_log WHERE url = ? LIMIT 1'
  ).bind(url).first<IngestLogRow>()
  return row ? fromIngestLogRow(row) : null
}

export async function updateIngestLog(
  db: D1Database,
  id: string,
  updates: {
    status?: IngestLog['status']
    url?: string
    atoms_created?: number
    atoms_skipped?: number
    relations_created?: number
    extraction_json?: Record<string, unknown>
    error_message?: string
    completed_at?: string
    source_id?: string
    document_id?: string
    chunks_created?: number
    step_status?: Record<string, string>
  }
): Promise<void> {
  const sets: string[] = []
  const binds: unknown[] = []

  if (updates.url !== undefined) { sets.push('url = ?'); binds.push(updates.url) }
  if (updates.status !== undefined) { sets.push('status = ?'); binds.push(updates.status) }
  if (updates.atoms_created !== undefined) { sets.push('atoms_created = ?'); binds.push(updates.atoms_created) }
  if (updates.atoms_skipped !== undefined) { sets.push('atoms_skipped = ?'); binds.push(updates.atoms_skipped) }
  if (updates.relations_created !== undefined) { sets.push('relations_created = ?'); binds.push(updates.relations_created) }
  if (updates.extraction_json !== undefined) { sets.push('extraction_json = ?'); binds.push(JSON.stringify(updates.extraction_json)) }
  if (updates.error_message !== undefined) { sets.push('error_message = ?'); binds.push(updates.error_message) }
  if (updates.completed_at !== undefined) { sets.push('completed_at = ?'); binds.push(updates.completed_at) }
  if (updates.source_id !== undefined) { sets.push('source_id = ?'); binds.push(updates.source_id) }
  if (updates.document_id !== undefined) { sets.push('document_id = ?'); binds.push(updates.document_id) }
  if (updates.chunks_created !== undefined) { sets.push('chunks_created = ?'); binds.push(updates.chunks_created) }
  if (updates.step_status !== undefined) { sets.push('step_status = ?'); binds.push(JSON.stringify(updates.step_status)) }

  if (sets.length === 0) return

  binds.push(id)
  await db.prepare(
    `UPDATE ingest_log SET ${sets.join(', ')} WHERE id = ?`
  ).bind(...binds).run()
}

export async function listIngestLogs(
  db: D1Database,
  opts: { status?: string; source_type?: string; limit?: number } = {}
): Promise<IngestLog[]> {
  const limit = Math.min(opts.limit ?? 50, 200)
  const parts: string[] = []
  const binds: unknown[] = []

  if (opts.status) { parts.push('status = ?'); binds.push(opts.status) }
  if (opts.source_type) { parts.push('source_type = ?'); binds.push(opts.source_type) }

  const where = parts.length > 0 ? `WHERE ${parts.join(' AND ')}` : ''
  binds.push(limit)

  const result = await db.prepare(
    `SELECT * FROM ingest_log ${where} ORDER BY created_at DESC LIMIT ?`
  ).bind(...binds).all<IngestLogRow>()

  return (result.results ?? []).map(fromIngestLogRow)
}
