// Usage telemetry: log API queries to usage_log table

export interface TelemetryEntry {
  agent: string
  endpoint: string
  query: string
  atomIdsReturned: string[]
  responseTimeMs: number
}

export async function logUsage(db: D1Database, entry: TelemetryEntry): Promise<void> {
  try {
    await db.prepare(
      `INSERT INTO usage_log (agent, endpoint, query, atom_ids_returned, response_time_ms)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(
      entry.agent,
      entry.endpoint,
      entry.query,
      JSON.stringify(entry.atomIdsReturned),
      entry.responseTimeMs
    ).run()
  } catch (error) {
    // Don't let telemetry failures break the main flow
    console.error('telemetry_log_fail', error)
  }
}

export async function getUsageHotspots(
  db: D1Database,
  hoursBack = 24
): Promise<{ endpoint: string; count: number }[]> {
  const cutoff = new Date()
  cutoff.setHours(cutoff.getHours() - hoursBack)

  const result = await db.prepare(
    `SELECT endpoint, COUNT(*) as count FROM usage_log
     WHERE created_at >= ?
     GROUP BY endpoint ORDER BY count DESC LIMIT 10`
  ).bind(cutoff.toISOString()).all<{ endpoint: string; count: number }>()

  return result.results ?? []
}
