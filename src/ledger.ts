// Session ledger for HobBot pipeline actions.
// Tracks ingestions, selections, generations, posts, and failures
// across content tracks for dedup and coordination.

export interface LedgerEntry {
  id?: number
  action_type: 'ingested' | 'selected' | 'generated' | 'posted' | 'scheduled' | 'failed'
  content_track?: string
  topic_key?: string
  payload?: Record<string, unknown>
  source_ids?: string[]
  atom_ids?: string[]
  arrangement_slug?: string
  x_post_id?: string
  status?: 'pending' | 'complete' | 'failed' | 'skipped'
  created_at?: string
  completed_at?: string
}

interface LedgerRow {
  id: number
  action_type: string
  content_track: string
  topic_key: string | null
  payload: string | null
  source_ids: string | null
  atom_ids: string | null
  arrangement_slug: string | null
  x_post_id: string | null
  created_at: string
  completed_at: string | null
  status: string
}

function fromRow(row: LedgerRow): LedgerEntry {
  return {
    id: row.id,
    action_type: row.action_type as LedgerEntry['action_type'],
    content_track: row.content_track,
    topic_key: row.topic_key ?? undefined,
    payload: row.payload ? JSON.parse(row.payload) : undefined,
    source_ids: row.source_ids ? JSON.parse(row.source_ids) : undefined,
    atom_ids: row.atom_ids ? JSON.parse(row.atom_ids) : undefined,
    arrangement_slug: row.arrangement_slug ?? undefined,
    x_post_id: row.x_post_id ?? undefined,
    status: row.status as LedgerEntry['status'],
    created_at: row.created_at,
    completed_at: row.completed_at ?? undefined,
  }
}

export async function logAction(db: D1Database, entry: LedgerEntry): Promise<number> {
  const result = await db.prepare(
    `INSERT INTO hobbot_actions
       (action_type, content_track, topic_key, payload, source_ids, atom_ids, arrangement_slug, x_post_id, status, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    entry.action_type,
    entry.content_track ?? 'atomic-noir',
    entry.topic_key ?? null,
    entry.payload ? JSON.stringify(entry.payload) : null,
    entry.source_ids ? JSON.stringify(entry.source_ids) : null,
    entry.atom_ids ? JSON.stringify(entry.atom_ids) : null,
    entry.arrangement_slug ?? null,
    entry.x_post_id ?? null,
    entry.status ?? 'pending',
    entry.completed_at ?? null,
  ).run()
  return result.meta.last_row_id as number
}

export async function getRecentActions(
  db: D1Database,
  opts: { track?: string; type?: string; since?: string; limit?: number } = {},
): Promise<LedgerEntry[]> {
  const conditions: string[] = []
  const binds: unknown[] = []

  if (opts.track) {
    conditions.push('content_track = ?')
    binds.push(opts.track)
  }
  if (opts.type) {
    conditions.push('action_type = ?')
    binds.push(opts.type)
  }
  if (opts.since) {
    conditions.push('created_at >= ?')
    binds.push(opts.since)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = Math.min(opts.limit ?? 50, 200)

  const { results } = await db.prepare(
    `SELECT * FROM hobbot_actions ${where} ORDER BY created_at DESC LIMIT ?`
  ).bind(...binds, limit).all<LedgerRow>()

  return (results ?? []).map(fromRow)
}

export async function hasRecentTopic(
  db: D1Database,
  topic_key: string,
  hours: number,
): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 FROM hobbot_actions
     WHERE topic_key = ?
       AND created_at >= datetime('now', ? || ' hours')
       AND status != 'failed'
     LIMIT 1`
  ).bind(topic_key, -hours).first()
  return row !== null
}

export async function getLastPosted(
  db: D1Database,
  track: string,
): Promise<LedgerEntry | null> {
  const row = await db.prepare(
    `SELECT * FROM hobbot_actions
     WHERE content_track = ?
       AND action_type = 'posted'
       AND status = 'complete'
     ORDER BY created_at DESC
     LIMIT 1`
  ).bind(track).first<LedgerRow>()
  return row ? fromRow(row) : null
}
