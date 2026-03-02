// SQL layer for Knowledge Layer: documents and document_chunks
// All SQL for these tables lives here.

import { QUERY } from '../config'
import {
  safeJson,
  fromDocumentRow, fromChunkRow,
  type Document, type DocumentRow,
  type DocumentChunk, type DocumentChunkRow,
  type ChunkSearchResult, type ChunkSearchResultRow,
} from '../grimoire/types'

// ---------- Documents ----------

export async function insertDocument(
  db: D1Database,
  doc: Omit<Document, 'created_at' | 'updated_at'>
): Promise<void> {
  await db.prepare(
    `INSERT INTO documents (id, title, description, mime_type, r2_key, source_url, tags,
     token_count, chunk_count, status, source_app, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).bind(
    doc.id, doc.title, doc.description ?? null, doc.mime_type,
    doc.r2_key ?? null, doc.source_url ?? null, JSON.stringify(doc.tags ?? []),
    doc.token_count ?? null, doc.chunk_count ?? 0, doc.status,
    doc.source_app ?? null
  ).run()
}

export async function updateDocumentStatus(
  db: D1Database,
  id: string,
  status: Document['status'],
  chunk_count?: number
): Promise<void> {
  if (chunk_count !== undefined) {
    await db.prepare(
      `UPDATE documents SET status = ?, chunk_count = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(status, chunk_count, id).run()
  } else {
    await db.prepare(
      `UPDATE documents SET status = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(status, id).run()
  }
}

export async function getDocument(
  db: D1Database,
  id: string
): Promise<{ document: Document; chunks: DocumentChunk[] } | null> {
  const docRow = await db.prepare(
    'SELECT * FROM documents WHERE id = ?'
  ).bind(id).first<DocumentRow>()
  if (!docRow) return null

  const chunkResult = await db.prepare(
    'SELECT * FROM document_chunks WHERE document_id = ? ORDER BY chunk_index'
  ).bind(id).all<DocumentChunkRow>()

  return {
    document: fromDocumentRow(docRow),
    chunks: (chunkResult.results ?? []).map(fromChunkRow),
  }
}

export async function listDocuments(
  db: D1Database,
  opts: { status?: string; mime_type?: string; source_app?: string; limit?: number } = {}
): Promise<Document[]> {
  const limit = Math.min(opts.limit ?? 50, 200)
  const parts: string[] = []
  const binds: unknown[] = []

  if (opts.status) { parts.push('status = ?'); binds.push(opts.status) }
  if (opts.mime_type) { parts.push('mime_type = ?'); binds.push(opts.mime_type) }
  if (opts.source_app) { parts.push('source_app = ?'); binds.push(opts.source_app) }

  binds.push(limit)
  const where = parts.length > 0 ? `WHERE ${parts.join(' AND ')}` : ''
  const sql = `SELECT * FROM documents ${where} ORDER BY created_at DESC LIMIT ?`
  const result = await db.prepare(sql).bind(...binds).all<DocumentRow>()
  return (result.results ?? []).map(fromDocumentRow)
}

// ---------- Chunks ----------

export async function insertChunk(
  db: D1Database,
  chunk: Omit<DocumentChunk, 'created_at'>
): Promise<void> {
  await db.prepare(
    `INSERT INTO document_chunks (id, document_id, chunk_index, content, summary,
     token_count, category_slug, arrangement_slugs, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).bind(
    chunk.id, chunk.document_id, chunk.chunk_index, chunk.content,
    chunk.summary ?? null, chunk.token_count ?? null,
    chunk.category_slug ?? null,
    JSON.stringify(chunk.arrangement_slugs ?? []),
    JSON.stringify(chunk.metadata ?? {})
  ).run()
}

export async function searchChunks(
  db: D1Database,
  query: string,
  opts: { category?: string; arrangement?: string; document_id?: string; limit?: number } = {}
): Promise<ChunkSearchResult[]> {
  const limit = Math.min(opts.limit ?? QUERY.DEFAULT_SEARCH_LIMIT, QUERY.MAX_SEARCH_LIMIT)
  const parts: string[] = ["c.content LIKE '%' || ? || '%'"]
  const binds: unknown[] = [query.toLowerCase()]

  if (opts.category) { parts.push('c.category_slug = ?'); binds.push(opts.category) }
  if (opts.arrangement) { parts.push("c.arrangement_slugs LIKE '%' || ? || '%'"); binds.push(opts.arrangement) }
  if (opts.document_id) { parts.push('c.document_id = ?'); binds.push(opts.document_id) }

  binds.push(limit)
  const sql = `SELECT c.*, d.title as document_title
    FROM document_chunks c
    JOIN documents d ON c.document_id = d.id
    WHERE ${parts.join(' AND ')}
    ORDER BY c.chunk_index ASC
    LIMIT ?`

  const result = await db.prepare(sql).bind(...binds).all<ChunkSearchResultRow>()
  return (result.results ?? []).map(row => ({
    ...fromChunkRow(row),
    document_title: row.document_title,
  }))
}

// ---------- Counts (for stats) ----------

export async function getDocumentCounts(
  db: D1Database
): Promise<{ document_count: number; chunk_count: number }> {
  const [docRow, chunkRow] = await Promise.all([
    db.prepare('SELECT COUNT(*) as count FROM documents').first<{ count: number }>(),
    db.prepare('SELECT COUNT(*) as count FROM document_chunks').first<{ count: number }>(),
  ])
  return {
    document_count: docRow?.count ?? 0,
    chunk_count: chunkRow?.count ?? 0,
  }
}
