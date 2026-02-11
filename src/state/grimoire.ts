// Grimoire: H0BBOT's Semantic Memory (patterns + interactions)

import { safeD1Value } from '../utils/d1';

export interface Pattern {
  id: string;
  name: string;
  definition: string;
  observation_count: number;
}

/**
 * Recalls patterns relevant to the current context.
 * Currently fetches ALL patterns (low volume).
 * Future upgrade: Vector search on 'definition'.
 */
export async function recallPatterns(db: D1Database): Promise<Pattern[]> {
  try {
    const result = await db.prepare(
      'SELECT id, name, definition, observation_count FROM patterns ORDER BY observation_count DESC'
    ).all<Pattern>();
    return result.results || [];
  } catch (error) {
    console.error('grimoire_recall_fail', error);
    return []; // Fail gracefully (amnesia is better than crash)
  }
}

/**
 * Records a specific interaction where a pattern was applied.
 */
export async function recordInteraction(
  db: D1Database,
  patternId: string,
  postId: string,
  authorHash: string,
  strategy: string,
  inputExcerpt: string
): Promise<void> {
  try {
    // Log the interaction
    await db.prepare(
      `INSERT INTO interactions (pattern_id, post_id, author_hash, response_strategy, input_excerpt)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(
      safeD1Value(patternId),
      safeD1Value(postId),
      safeD1Value(authorHash),
      safeD1Value(strategy),
      safeD1Value(inputExcerpt.slice(0, 100))
    ).run();

    // Increment observation count
    await db.prepare(
      'UPDATE patterns SET observation_count = observation_count + 1, last_seen_at = datetime("now") WHERE id = ?'
    ).bind(safeD1Value(patternId)).run();

    console.log(`grimoire_record: pattern=${patternId}, strategy=${strategy}`);
  } catch (error) {
    console.error('grimoire_record_fail', error);
  }
}
