// Dream Evolution: tracks how pattern definitions change over time
// Zero AI calls. Pure comparison logic and D1 writes.

import type { D1Database } from '@cloudflare/workers-types';
import { calculateSimilarity } from '../pipeline/extract-patterns';
import type { PatternSnapshot, PatternEvolution } from './types';

const SIMILARITY_THRESHOLD = 0.9;
const COUNT_CHANGE_THRESHOLD = 3;

interface EvolutionSnapshot {
  snapshot_version: number;
  structural_description: string;
  observed_count: number;
}

/**
 * Snapshot patterns that have meaningfully changed since their last snapshot.
 * A new snapshot is created when:
 * - Description similarity drops below 0.9 (text changed meaningfully)
 * - OR observed_count increased by 3+
 */
export async function snapshotPatterns(
  db: D1Database,
  patterns: PatternSnapshot[],
): Promise<PatternEvolution[]> {
  const evolutions: PatternEvolution[] = [];

  for (const pattern of patterns) {
    try {
      // Load most recent snapshot for this pattern
      const latest = await db.prepare(`
        SELECT snapshot_version, structural_description, observed_count
        FROM pattern_evolution
        WHERE pattern_id = ?
        ORDER BY snapshot_version DESC
        LIMIT 1
      `).bind(pattern.pattern_id).first<EvolutionSnapshot>();

      let shouldSnapshot = false;
      const changeParts: string[] = [];

      if (!latest) {
        // First snapshot ever for this pattern
        shouldSnapshot = true;
        changeParts.push('Initial snapshot');
      } else {
        // Check description similarity
        const similarity = calculateSimilarity(
          latest.structural_description,
          pattern.structural_description,
        );

        if (similarity < SIMILARITY_THRESHOLD) {
          shouldSnapshot = true;
          changeParts.push(`Description refined (similarity ${similarity.toFixed(2)})`);
        }

        // Check count change
        const countDelta = pattern.observed_count - latest.observed_count;
        if (countDelta >= COUNT_CHANGE_THRESHOLD) {
          shouldSnapshot = true;
          changeParts.push(`Count: ${latest.observed_count} -> ${pattern.observed_count}`);
        }
      }

      if (!shouldSnapshot) continue;

      const nextVersion = latest ? latest.snapshot_version + 1 : 1;
      const changeSummary = changeParts.join('. ');

      // Write snapshot
      await db.prepare(`
        INSERT INTO pattern_evolution
          (pattern_id, snapshot_version, structural_description, geometric_metaphor,
           observed_count, generation_seeds, category, change_summary)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        pattern.pattern_id,
        nextVersion,
        pattern.structural_description,
        pattern.geometric_metaphor,
        pattern.observed_count,
        JSON.stringify(pattern.generation_seeds),
        pattern.category,
        changeSummary,
      ).run();

      evolutions.push({
        pattern_id: pattern.pattern_id,
        pattern_name: pattern.pattern_name,
        previous_description: latest?.structural_description ?? null,
        current_description: pattern.structural_description,
        previous_count: latest?.observed_count ?? null,
        current_count: pattern.observed_count,
        change_summary: changeSummary,
      });

      console.log(`dream_evolve: pattern=${pattern.pattern_name}, version=${nextVersion}, change="${changeSummary}"`);
    } catch (error) {
      console.error(`dream_evolve: failed for ${pattern.pattern_name}`, error);
    }
  }

  return evolutions;
}

/**
 * Get evolution history for a specific pattern.
 */
export async function getPatternHistory(
  db: D1Database,
  patternId: string,
  limit: number = 5,
): Promise<Array<{ version: number; description: string; count: number; snapshot_at: string }>> {
  const result = await db.prepare(`
    SELECT snapshot_version as version, structural_description as description,
           observed_count as count, snapshot_at
    FROM pattern_evolution
    WHERE pattern_id = ?
    ORDER BY snapshot_version DESC
    LIMIT ?
  `).bind(patternId, limit).all<{
    version: number;
    description: string;
    count: number;
    snapshot_at: string;
  }>();
  return result.results ?? [];
}
