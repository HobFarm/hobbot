// Author signal tracking

import type { AttackType } from '../pipeline/attack-patterns';
import { safeD1Value } from '../utils/d1';

export interface AuthorSignal {
  author_hash: string;
  timestamp: string;
  post_id: string;
  signal_type?: 'extraction' | 'drift' | 'attack';
  content_hash?: string;
  emoji_signature?: string;
  attack_type?: AttackType;
}

/**
 * Records an author signal
 */
export async function recordAuthorSignal(
  db: D1Database,
  authorHash: string,
  postId: string
): Promise<void> {
  const timestamp = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO author_signals (author_hash, timestamp, post_id)
       VALUES (?, ?, ?)`
    )
    .bind(safeD1Value(authorHash), timestamp, safeD1Value(postId))
    .run();
}

/**
 * Gets count of recent author signals
 */
export async function getRecentSignalCount(
  db: D1Database,
  authorHash: string,
  hoursBack: number = 24
): Promise<number> {
  const cutoffTime = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();

  const result = await db
    .prepare(
      `SELECT COUNT(*) as count
       FROM author_signals
       WHERE author_hash = ?
       AND timestamp >= ?`
    )
    .bind(authorHash, cutoffTime)
    .first<{ count: number }>();

  return result?.count ?? 0;
}

/**
 * Cleans up old author signal records
 */
export async function cleanOldAuthorSignals(
  db: D1Database,
  hoursBack: number = 48
): Promise<number> {
  const cutoffTime = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();

  const result = await db
    .prepare(
      `DELETE FROM author_signals
       WHERE timestamp < ?`
    )
    .bind(cutoffTime)
    .run();

  return result.meta.changes;
}

/**
 * Gets recent author signals for monitoring
 */
export async function getRecentAuthorSignals(
  db: D1Database,
  limit: number = 10
): Promise<AuthorSignal[]> {
  const result = await db
    .prepare(
      `SELECT * FROM author_signals
       ORDER BY timestamp DESC
       LIMIT ?`
    )
    .bind(limit)
    .all<AuthorSignal>();

  return result.results ?? [];
}

/**
 * Records a drift attack signal
 */
export async function recordDriftSignal(
  db: D1Database,
  authorHash: string,
  postId: string,
  contentHash: string,
  emojiSignature?: string
): Promise<void> {
  const timestamp = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO author_signals (author_hash, timestamp, post_id, signal_type, content_hash, emoji_signature)
       VALUES (?, ?, ?, 'drift', ?, ?)`
    )
    .bind(safeD1Value(authorHash), timestamp, safeD1Value(postId), safeD1Value(contentHash), safeD1Value(emojiSignature ?? null))
    .run();
}

/**
 * Records an attack signal with type classification
 */
export async function recordAttackSignal(
  db: D1Database,
  authorHash: string,
  postId: string,
  attackType: AttackType,
  details: string
): Promise<void> {
  const timestamp = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO author_signals (author_hash, timestamp, post_id, signal_type, attack_type, content_hash)
       VALUES (?, ?, ?, 'attack', ?, ?)`
    )
    .bind(safeD1Value(authorHash), timestamp, safeD1Value(postId), safeD1Value(attackType), safeD1Value(details))
    .run();
}

/**
 * Gets count of recent drift signals from an author
 */
export async function getRecentDriftCount(
  db: D1Database,
  authorHash: string,
  hoursBack: number = 24
): Promise<number> {
  const cutoffTime = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();

  const result = await db
    .prepare(
      `SELECT COUNT(*) as count
       FROM author_signals
       WHERE author_hash = ?
       AND signal_type = 'drift'
       AND timestamp >= ?`
    )
    .bind(authorHash, cutoffTime)
    .first<{ count: number }>();

  return result?.count ?? 0;
}

/**
 * Gets count of recent attack signals from an author (any type)
 */
export async function getRecentAttackCount(
  db: D1Database,
  authorHash: string,
  hoursBack: number = 24
): Promise<number> {
  const cutoffTime = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();

  const result = await db
    .prepare(
      `SELECT COUNT(*) as count
       FROM author_signals
       WHERE author_hash = ?
       AND signal_type IN ('drift', 'attack')
       AND timestamp >= ?`
    )
    .bind(authorHash, cutoffTime)
    .first<{ count: number }>();

  return result?.count ?? 0;
}

/**
 * Checks if author has consistent emoji signature (bot indicator)
 */
export async function checkEmojiSignaturePattern(
  db: D1Database,
  authorHash: string,
  emojiSignature: string,
  hoursBack: number = 24
): Promise<number> {
  const cutoffTime = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();

  const result = await db
    .prepare(
      `SELECT COUNT(*) as count
       FROM author_signals
       WHERE author_hash = ?
       AND emoji_signature = ?
       AND timestamp >= ?`
    )
    .bind(authorHash, emojiSignature, cutoffTime)
    .first<{ count: number }>();

  return result?.count ?? 0;
}
