// Post deduplication to avoid re-processing

import type { MoltbookPost } from '../moltbook/types';

export interface SeenPost {
  post_id: string;
  first_seen_at: string;
  engaged: boolean;
  engagement_type: 'comment' | 'post' | null;
  score: number;
}

export async function hasSeenPost(
  db: D1Database,
  postId: string
): Promise<boolean> {
  const result = await db
    .prepare('SELECT post_id FROM seen_posts WHERE post_id = ?')
    .bind(postId)
    .first();

  return result !== null;
}

export async function markAsSeen(
  db: D1Database,
  postId: string,
  score: number
): Promise<void> {
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT OR IGNORE INTO seen_posts (post_id, first_seen_at, engaged, score)
       VALUES (?, ?, FALSE, ?)`
    )
    .bind(postId, now, score)
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
    .bind(type, postId)
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
    .bind(...postIds)
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
    .bind(postId)
    .first<SeenPost>();

  return result ?? null;
}
