// Grimoire validation event log: write, scan, and rejection events

export type AuditTrigger = 'write' | 'scan' | 'demand'
export type AuditResult = 'pass' | 'warn' | 'fail'

export async function logValidationEvent(
  db: D1Database,
  triggerType: AuditTrigger,
  atomId: string | null,
  result: AuditResult,
  details: Record<string, unknown> = {}
): Promise<void> {
  try {
    await db.prepare(
      `INSERT INTO validation_log (trigger_type, atom_id, result, details)
       VALUES (?, ?, ?, ?)`
    ).bind(triggerType, atomId ?? null, result, JSON.stringify(details)).run()
  } catch (error) {
    console.error('audit_log_fail', error)
  }
}

export async function getRecentValidationResults(
  db: D1Database,
  limit = 20
): Promise<{ result: AuditResult; count: number }[]> {
  const rows = await db.prepare(
    `SELECT result, COUNT(*) as count FROM validation_log
     WHERE created_at >= datetime('now', '-24 hours')
     GROUP BY result`
  ).all<{ result: AuditResult; count: number }>()
  return (rows.results ?? []).slice(0, limit)
}

export async function hashContent(content: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(content)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}
