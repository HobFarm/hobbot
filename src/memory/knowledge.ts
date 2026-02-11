// Knowledge CRUD operations for memory_knowledge table

import type { D1Database } from '@cloudflare/workers-types';
import type { KnowledgeType, MemoryKnowledge } from './types';

/**
 * Upsert a knowledge entry. If it exists, update content and bump confidence.
 * Confidence formula: min(1.0, existing + 0.1 * (1 - existing))
 * This asymptotically approaches 1.0; each evidence bumps by 10% of remaining gap.
 */
export async function upsertKnowledge(
  db: D1Database,
  type: KnowledgeType,
  key: string,
  content: string,
  structuredData?: Record<string, unknown>,
  evidenceCount: number = 1
): Promise<{ id: number; isNew: boolean }> {
  const now = new Date().toISOString();
  const structuredJson = structuredData ? JSON.stringify(structuredData) : null;

  // Try insert first
  const insertResult = await db.prepare(`
    INSERT INTO memory_knowledge
      (knowledge_type, knowledge_key, content, structured_data, confidence, evidence_count,
       first_created_at, last_updated_at, last_evidence_at)
    VALUES (?, ?, ?, ?, 0.3, ?, ?, ?, ?)
    ON CONFLICT(knowledge_type, knowledge_key) DO UPDATE SET
      content = excluded.content,
      structured_data = COALESCE(excluded.structured_data, memory_knowledge.structured_data),
      confidence = MIN(1.0, memory_knowledge.confidence + 0.1 * (1.0 - memory_knowledge.confidence)),
      evidence_count = memory_knowledge.evidence_count + excluded.evidence_count,
      last_updated_at = excluded.last_updated_at,
      last_evidence_at = excluded.last_evidence_at
  `).bind(type, key, content, structuredJson, evidenceCount, now, now, now).run();

  const id = insertResult.meta.last_row_id ?? 0;

  // Determine if this was a new insert or update
  const entry = await db.prepare(
    `SELECT id, evidence_count FROM memory_knowledge WHERE knowledge_type = ? AND knowledge_key = ?`
  ).bind(type, key).first<{ id: number; evidence_count: number }>();

  return {
    id: entry?.id ?? id,
    isNew: (entry?.evidence_count ?? 1) <= evidenceCount
  };
}

/**
 * Reduce confidence for contradictory evidence and update content.
 */
export async function contradictKnowledge(
  db: D1Database,
  type: KnowledgeType,
  key: string,
  newContent: string
): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare(`
    UPDATE memory_knowledge
    SET content = ?,
        confidence = MAX(0.1, confidence - 0.15),
        last_updated_at = ?,
        last_evidence_at = ?
    WHERE knowledge_type = ? AND knowledge_key = ?
  `).bind(newContent, now, now, type, key).run();
}

/**
 * Get a single knowledge entry by type and key.
 */
export async function getKnowledge(
  db: D1Database,
  type: KnowledgeType,
  key: string
): Promise<MemoryKnowledge | null> {
  return await db.prepare(
    `SELECT * FROM memory_knowledge WHERE knowledge_type = ? AND knowledge_key = ?`
  ).bind(type, key).first<MemoryKnowledge>() ?? null;
}

/**
 * Get knowledge entries by type, sorted by confidence.
 */
export async function getKnowledgeByType(
  db: D1Database,
  type: KnowledgeType,
  minConfidence: number = 0.2,
  limit: number = 10
): Promise<MemoryKnowledge[]> {
  const result = await db.prepare(`
    SELECT * FROM memory_knowledge
    WHERE knowledge_type = ? AND confidence >= ?
    ORDER BY confidence DESC
    LIMIT ?
  `).bind(type, minConfidence, limit).all<MemoryKnowledge>();
  return result.results ?? [];
}

/**
 * Query relevant knowledge for a specific context (author, submolt, topics).
 * Returns entries sorted by relevance: exact matches first, then by confidence.
 * Respects a character budget for use in prompt injection.
 */
export async function getRelevantKnowledge(
  db: D1Database,
  authorHash?: string,
  submolt?: string,
  topics?: string[],
  charBudget: number = 800
): Promise<MemoryKnowledge[]> {
  const results: MemoryKnowledge[] = [];
  let charsUsed = 0;

  // Priority 1: user_narrative for current author
  if (authorHash) {
    const userKnowledge = await db.prepare(`
      SELECT * FROM memory_knowledge
      WHERE knowledge_type = 'user_narrative' AND knowledge_key = ? AND confidence >= 0.2
    `).bind(authorHash).first<MemoryKnowledge>();
    if (userKnowledge) {
      const entryLen = formatKnowledgeEntry(userKnowledge).length;
      if (charsUsed + entryLen <= charBudget) {
        results.push(userKnowledge);
        charsUsed += entryLen;
      }
    }
  }

  // Priority 2: community_insight for current submolt
  if (submolt) {
    const communityKnowledge = await db.prepare(`
      SELECT * FROM memory_knowledge
      WHERE knowledge_type = 'community_insight' AND knowledge_key = ? AND confidence >= 0.2
    `).bind(submolt).first<MemoryKnowledge>();
    if (communityKnowledge) {
      const entryLen = formatKnowledgeEntry(communityKnowledge).length;
      if (charsUsed + entryLen <= charBudget) {
        results.push(communityKnowledge);
        charsUsed += entryLen;
      }
    }
  }

  // Priority 3: topic_expertise matching topic keywords
  if (topics && topics.length > 0) {
    for (const topic of topics.slice(0, 3)) {
      if (charsUsed >= charBudget) break;
      const topicKnowledge = await db.prepare(`
        SELECT * FROM memory_knowledge
        WHERE knowledge_type = 'topic_expertise' AND knowledge_key = ? AND confidence >= 0.2
      `).bind(topic).first<MemoryKnowledge>();
      if (topicKnowledge) {
        const entryLen = formatKnowledgeEntry(topicKnowledge).length;
        if (charsUsed + entryLen <= charBudget) {
          results.push(topicKnowledge);
          charsUsed += entryLen;
        }
      }
    }
  }

  // Priority 4: high-confidence engagement strategies (fill remaining budget)
  if (charsUsed < charBudget) {
    const strategies = await db.prepare(`
      SELECT * FROM memory_knowledge
      WHERE knowledge_type = 'engagement_strategy' AND confidence >= 0.4
      ORDER BY confidence DESC
      LIMIT 3
    `).all<MemoryKnowledge>();
    for (const strategy of strategies.results ?? []) {
      if (charsUsed >= charBudget) break;
      const entryLen = formatKnowledgeEntry(strategy).length;
      if (charsUsed + entryLen <= charBudget) {
        results.push(strategy);
        charsUsed += entryLen;
      }
    }
  }

  return results;
}

/**
 * Format a knowledge entry for prompt injection.
 * Prefers structured_data when available, falls back to content.
 * Used both for display and for measuring character budget.
 */
export function formatKnowledgeEntry(entry: MemoryKnowledge): string {
  if (entry.structured_data) {
    try {
      const data = JSON.parse(entry.structured_data);
      return `[${entry.knowledge_type}] ${entry.knowledge_key} (conf:${entry.confidence.toFixed(2)}): ${JSON.stringify(data)}`;
    } catch {
      // Fall through to content
    }
  }
  return `[${entry.knowledge_type}] ${entry.knowledge_key} (conf:${entry.confidence.toFixed(2)}): ${entry.content}`;
}

/**
 * Decay confidence for knowledge entries that haven't received new evidence.
 * Multiplies confidence by 0.9 for entries not evidenced in staleDays.
 */
export async function decayStaleKnowledge(
  db: D1Database,
  staleDays: number = 14
): Promise<number> {
  const result = await db.prepare(`
    UPDATE memory_knowledge
    SET confidence = confidence * 0.9,
        decay_applied_at = datetime('now')
    WHERE last_evidence_at < datetime('now', '-' || ? || ' days')
      AND confidence > 0.1
      AND (decay_applied_at IS NULL OR decay_applied_at < datetime('now', '-1 day'))
  `).bind(staleDays).run();
  return result.meta.changes ?? 0;
}

/**
 * Delete knowledge entries that have decayed below usefulness threshold.
 */
export async function pruneDeadKnowledge(
  db: D1Database,
  minConfidence: number = 0.1
): Promise<number> {
  const result = await db.prepare(`
    DELETE FROM memory_knowledge WHERE confidence < ?
  `).bind(minConfidence).run();
  return result.meta.changes ?? 0;
}
