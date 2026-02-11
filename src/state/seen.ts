// Post deduplication to avoid re-processing

import type { MoltbookPost } from '../moltbook/types';
import type { ScoreSignals } from '../pipeline/score';
import type { DecisionTrace } from '../pipeline/decision-trace';
import { safeD1Value } from '../utils/d1';

export interface SeenPost {
  post_id: string;
  first_seen_at: string;
  engaged: boolean;
  engagement_type: 'comment' | 'post' | null;
  score: number;
  score_signals: string | null;
  discovery_source: string | null;
  decision_log: string | null;
  submolt: string | null;
}

export async function hasSeenPost(
  db: D1Database,
  postId: string
): Promise<boolean> {
  const result = await db
    .prepare('SELECT post_id FROM seen_posts WHERE post_id = ?')
    .bind(safeD1Value(postId))
    .first();

  return result !== null;
}

export async function markAsSeen(
  db: D1Database,
  postId: string,
  score: number,
  scoreSignals?: ScoreSignals,
  discoverySource?: string,
  decisionLog?: DecisionTrace,
  submolt?: string
): Promise<void> {
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT OR IGNORE INTO seen_posts (post_id, first_seen_at, engaged, score, score_signals, discovery_source, decision_log, submolt)
       VALUES (?, ?, FALSE, ?, ?, ?, ?, ?)`
    )
    .bind(
      safeD1Value(postId),
      now,
      score,
      scoreSignals ? JSON.stringify(scoreSignals) : null,
      discoverySource ?? null,
      decisionLog ? JSON.stringify(decisionLog) : null,
      safeD1Value(submolt ?? null)
    )
    .run();
}

export async function recordEngagement(
  db: D1Database,
  postId: string,
  type: 'comment' | 'post'
): Promise<void> {
  await db
    .prepare(
      `UPDATE seen_posts
       SET engaged = TRUE,
           engagement_type = ?
       WHERE post_id = ?`
    )
    .bind(type, safeD1Value(postId))
    .run();
}

export async function filterUnseenPosts(
  db: D1Database,
  posts: MoltbookPost[]
): Promise<MoltbookPost[]> {
  if (posts.length === 0) {
    return [];
  }

  // Get all seen post IDs
  const postIds = posts.map(p => p.id);
  const placeholders = postIds.map(() => '?').join(',');

  const seenResults = await db
    .prepare(`SELECT post_id FROM seen_posts WHERE post_id IN (${placeholders})`)
    .bind(...postIds.map(safeD1Value))
    .all<{ post_id: string }>();

  const seenIds = new Set(seenResults.results?.map(r => r.post_id) ?? []);

  // Filter out seen posts
  return posts.filter(post => !seenIds.has(post.id));
}

export async function getSeenPost(
  db: D1Database,
  postId: string
): Promise<SeenPost | null> {
  const result = await db
    .prepare('SELECT * FROM seen_posts WHERE post_id = ?')
    .bind(safeD1Value(postId))
    .first<SeenPost>();

  return result ?? null;
}

// Thread blacklist: sticky skip decisions that persist across cycles

export async function isBlacklisted(db: D1Database, postId: string): Promise<boolean> {
  const row = await db.prepare(
    `SELECT post_id FROM blacklisted_threads WHERE post_id = ? AND expires_at > datetime('now')`
  ).bind(safeD1Value(postId)).first();
  return row !== null;
}

export async function blacklistThread(db: D1Database, postId: string, reason: string, hours: number = 24): Promise<void> {
  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  await db.prepare(
    `INSERT OR REPLACE INTO blacklisted_threads (post_id, reason, expires_at)
     VALUES (?, ?, ?)`
  ).bind(safeD1Value(postId), reason, expiresAt).run();
}

export async function cleanExpiredBlacklist(db: D1Database): Promise<number> {
  const result = await db.prepare(
    `DELETE FROM blacklisted_threads WHERE expires_at <= datetime('now')`
  ).run();
  return result.meta?.changes ?? 0;
}
