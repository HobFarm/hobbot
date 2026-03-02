// Grimoire custodian worker entry point

import { createMcpHandler } from 'agents/mcp'
import { createGrimoireMcpServer } from './mcp/server'
import { handleApiRequest } from './api/routes'
import { buildHealthDigest } from './pipeline/digest'
import { detectDrift } from './pipeline/drift-detect'
import { detectBulkImport, detectCircularRelations } from './pipeline/attack-patterns'
import { runMaintenance } from './pipeline/cleanup'
import { getAtomCounts, saveScanResult } from './state/grimoire'
import { getCorrespondenceStats, getOrphanedAtoms } from './state/graph'
import type { IntegrityIssue } from './grimoire/types'

export interface Env {
  GRIMOIRE_DB: D1Database
  HOBBOT_DB: D1Database
  GEMINI_API_KEY: string
  SERVICE_TOKENS: string
  AI_GATEWAY_URL?: string
  ENVIRONMENT: 'development' | 'production'
}

// Promote provisional atoms that meet all quality gates
async function promoteQualifiedAtoms(db: D1Database): Promise<number> {
  const result = await db.prepare(`
    UPDATE atoms
    SET status = 'confirmed',
        updated_at = datetime('now')
    WHERE status = 'provisional'
      AND category_slug IS NOT NULL
      AND category_slug != ''
      AND embedding_status = 'complete'
      AND harmonics IS NOT NULL
      AND harmonics != '{}'
      AND (
        EXISTS (
          SELECT 1 FROM correspondences
          WHERE atom_a_id = atoms.id OR atom_b_id = atoms.id
        )
        OR EXISTS (
          SELECT 1 FROM atom_relations
          WHERE source_atom_id = atoms.id OR target_atom_id = atoms.id
        )
        OR EXISTS (
          SELECT 1 FROM exemplars WHERE atom_id = atoms.id
        )
      )
    LIMIT 5000
  `).run()
  return result.meta.changes ?? 0
}

// Fix stale/null tier values on confirmed atoms
async function recalculateTiers(db: D1Database): Promise<number> {
  const result = await db.prepare(`
    UPDATE atoms SET tier = CASE
      WHEN EXISTS (SELECT 1 FROM exemplars WHERE atom_id = atoms.id)
       AND EXISTS (SELECT 1 FROM correspondences WHERE atom_a_id = atoms.id OR atom_b_id = atoms.id)
      THEN 1
      WHEN EXISTS (SELECT 1 FROM correspondences WHERE atom_a_id = atoms.id OR atom_b_id = atoms.id)
      THEN 2
      ELSE 3
    END
    WHERE status = 'confirmed'
      AND (tier IS NULL OR tier != CASE
        WHEN EXISTS (SELECT 1 FROM exemplars WHERE atom_id = atoms.id)
         AND EXISTS (SELECT 1 FROM correspondences WHERE atom_a_id = atoms.id OR atom_b_id = atoms.id)
        THEN 1
        WHEN EXISTS (SELECT 1 FROM correspondences WHERE atom_a_id = atoms.id OR atom_b_id = atoms.id)
        THEN 2
        ELSE 3
      END)
    LIMIT 5000
  `).run()
  return result.meta.changes ?? 0
}

// cron: 0 */6 * * *
// Full integrity scan of the correspondence graph (MAINTAIN mode)
async function runIntegrityScan(db: D1Database): Promise<void> {
  const start = Date.now()

  const [driftIssues, bulkIssues, circularIssues] = await Promise.all([
    detectDrift(db),
    detectBulkImport(db),
    detectCircularRelations(db),
  ])

  const allIssues: IntegrityIssue[] = [
    ...driftIssues,
    ...bulkIssues,
    ...circularIssues,
  ]

  // Promote qualified provisional atoms
  const promoted = await promoteQualifiedAtoms(db)
  if (promoted > 0) console.log(`[integrity] promoted ${promoted} atoms to confirmed`)

  // Fix stale tier values on confirmed atoms
  const tiersFixed = await recalculateTiers(db)
  if (tiersFixed > 0) console.log(`[integrity] recalculated ${tiersFixed} atom tiers`)

  const atomCount = await db.prepare('SELECT COUNT(*) as count FROM atoms').first<{ count: number }>()
  const scannedCount = atomCount?.count ?? 0
  const durationMs = Date.now() - start

  await saveScanResult(db, 'full', scannedCount, allIssues, durationMs)
  await runMaintenance(db)

  const highSeverity = allIssues.filter(i => i.severity === 'high').length
  console.log(`integrity_scan: atoms=${scannedCount} issues=${allIssues.length} high=${highSeverity} promoted=${promoted} tiers=${tiersFixed} ms=${durationMs}`)
}

// cron: 0 0 * * 1
// Weekly graph analysis report (EVOLVE mode)
// Stub: collects stats and writes summary to integrity_scans. Full analysis in a future pass.
async function runEvolveReport(db: D1Database): Promise<void> {
  const start = Date.now()

  const [atomCounts, corrStats, orphans] = await Promise.all([
    getAtomCounts(db),
    getCorrespondenceStats(db),
    getOrphanedAtoms(db, 100),
  ])

  const total = Object.values(atomCounts).reduce((sum, n) => sum + n, 0)
  const durationMs = Date.now() - start

  await saveScanResult(db, 'evolve', total, [{ stats: corrStats, orphan_count: orphans.length }], durationMs)
  console.log(`evolve_report: atoms=${total} correspondences=${corrStats.total} orphans=${orphans.length} ms=${durationMs}`)
}

function healthResponse(db: D1Database): Promise<Response> {
  return buildHealthDigest(db).then(digest =>
    new Response(JSON.stringify({ ok: true, ...digest }), {
      headers: { 'Content-Type': 'application/json' },
    })
  )
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp')) {
      const server = createGrimoireMcpServer(env)
      return createMcpHandler(server)(request, env, ctx)
    }

    if (url.pathname === '/') return healthResponse(env.GRIMOIRE_DB)
    if (url.pathname.startsWith('/api/')) return handleApiRequest(request, env)

    return new Response(JSON.stringify({ error: 'not found', code: 404 }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === '0 */6 * * *') {
      ctx.waitUntil(runIntegrityScan(env.GRIMOIRE_DB))
    } else if (event.cron === '0 0 * * 1') {
      ctx.waitUntil(runEvolveReport(env.GRIMOIRE_DB))
    }
  },
}
