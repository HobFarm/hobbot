// Health digest: atom counts, recent validations, last scan, usage hotspots

import { getAtomCounts, getLastScanResult, getCollections } from '../state/grimoire'
import { getCorrespondenceStats, getExemplarCount, getIncantationCount } from '../state/graph'
import { getRecentValidationResults } from '../state/audit'
import { getAllBudgets } from '../state/budget'
import type { AgentBudget, IntegrityScanResult, CorrespondenceStats } from '../grimoire/types'

export interface HealthDigest {
  atom_counts: Record<string, number>
  category_count: number
  collection_count: number
  correspondence_count: number
  correspondence_by_type: Record<string, number>
  exemplar_count: number
  incantation_count: number
  last_scan: IntegrityScanResult | null
  validation_results_24h: { result: string; count: number }[]
  agent_budgets: AgentBudget[]
  pending_validations: number
  generated_at: string
}

export async function buildHealthDigest(db: D1Database): Promise<HealthDigest> {
  const [atomCounts, lastScan, validations, budgets, collections, corrStats, exemplarCount, incantationCount] = await Promise.all([
    getAtomCounts(db),
    getLastScanResult(db),
    getRecentValidationResults(db),
    getAllBudgets(db),
    getCollections(db),
    getCorrespondenceStats(db),
    getExemplarCount(db),
    getIncantationCount(db),
  ])

  const catCount = await db.prepare('SELECT COUNT(*) as count FROM categories').first<{ count: number }>()

  return {
    atom_counts: atomCounts,
    category_count: catCount?.count ?? 0,
    collection_count: collections.length,
    correspondence_count: corrStats.total,
    correspondence_by_type: corrStats.byType,
    exemplar_count: exemplarCount,
    incantation_count: incantationCount,
    last_scan: lastScan,
    validation_results_24h: validations,
    agent_budgets: budgets,
    pending_validations: atomCounts['provisional'] ?? 0,
    generated_at: new Date().toISOString(),
  }
}
