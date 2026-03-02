// Correspondence drift detection
// Finds atoms with stale category assignments, orphaned collection references,
// and arrangements referencing missing categories

import { getCategories, getCollections, getArrangements } from '../state/grimoire'
import type { IntegrityIssue } from '../grimoire/types'

interface ScanChunk {
  id: string
  category_slug: string | null
  collection_slug: string
}

export async function detectDrift(db: D1Database): Promise<IntegrityIssue[]> {
  const issues: IntegrityIssue[] = []

  const [categories, collections, arrangements] = await Promise.all([
    getCategories(db),
    getCollections(db),
    getArrangements(db),
  ])

  const catSlugs = new Set(categories.map(c => c.slug))
  const colSlugs = new Set(collections.map(c => c.slug))

  const { count } = await db.prepare('SELECT COUNT(*) as count FROM atoms').first<{ count: number }>() ?? { count: 0 }
  const chunkSize = 500
  let offset = 0

  while (offset < count) {
    const chunk = await db.prepare(
      'SELECT id, category_slug, collection_slug FROM atoms LIMIT ? OFFSET ?'
    ).bind(chunkSize, offset).all<ScanChunk>()

    for (const row of chunk.results ?? []) {
      if (row.category_slug && !catSlugs.has(row.category_slug)) {
        issues.push({
          type: 'missing_category',
          atom_id: row.id,
          description: `category '${row.category_slug}' not in categories table`,
          severity: 'high',
        })
      }
      if (!colSlugs.has(row.collection_slug)) {
        issues.push({
          type: 'orphan',
          atom_id: row.id,
          description: `collection '${row.collection_slug}' not in collections table`,
          severity: 'medium',
        })
      }
    }

    offset += chunkSize
  }

  for (const arr of arrangements) {
    const weights = arr.category_weights as Record<string, number>
    for (const slug of Object.keys(weights)) {
      if (!catSlugs.has(slug)) {
        issues.push({
          type: 'missing_category',
          description: `arrangement '${arr.slug}' references missing category '${slug}'`,
          severity: 'medium',
        })
      }
    }
  }

  // Atoms with complete embeddings but no correspondence entries
  // (harmonic discovery should have linked them)
  const embeddingRow = await db.prepare(
    `SELECT COUNT(*) as count FROM atoms
     WHERE embedding_status = 'complete'
     AND status != 'rejected'
     AND id NOT IN (
       SELECT DISTINCT atom_a_id FROM correspondences
       UNION
       SELECT DISTINCT atom_b_id FROM correspondences
     )`
  ).first<{ count: number }>()
  const ungraphed = embeddingRow?.count ?? 0
  if (ungraphed > 0) {
    issues.push({
      type: 'embedding_gap',
      description: `${ungraphed} atoms have complete embeddings but no correspondence entries`,
      severity: 'medium',
    })
  }

  // Correspondences referencing atom IDs that no longer exist
  const orphanedRefRow = await db.prepare(
    `SELECT COUNT(*) as count FROM correspondences c
     WHERE NOT EXISTS (SELECT 1 FROM atoms WHERE id = c.atom_a_id)
        OR NOT EXISTS (SELECT 1 FROM atoms WHERE id = c.atom_b_id)`
  ).first<{ count: number }>()
  const orphanedRefs = orphanedRefRow?.count ?? 0
  if (orphanedRefs > 0) {
    issues.push({
      type: 'orphaned_ref',
      description: `${orphanedRefs} correspondence rows reference atom IDs not in atoms table`,
      severity: 'high',
    })
  }

  // Categories with zero atoms assigned (informational)
  const emptyCatResult = await db.prepare(
    `SELECT slug FROM categories
     WHERE slug NOT IN (SELECT DISTINCT category_slug FROM atoms WHERE category_slug IS NOT NULL)`
  ).all<{ slug: string }>()
  for (const row of emptyCatResult.results ?? []) {
    issues.push({
      type: 'coverage_gap',
      description: `category '${row.slug}' has no atoms assigned`,
      severity: 'low',
    })
  }

  return issues
}
