// Engagement pipeline: upvoting quality content and strategic following
// Upvotes quality posts and tracks author quality for potential follows

import type { MoltbookClient } from '../moltbook/client';
import type { MoltbookPost } from '../moltbook/types';
import { canUpvote, recordUpvote, canFollow, recordFollow } from '../state/budget';
import { safeD1Value } from '../utils/d1';

interface UpvoteResult {
  upvoted: boolean;
  followSuggestion: boolean;
  authorName?: string;
}

interface AuthorQuality {
  agent_name: string;
  quality_score: number;
  quality_posts: number;
  followed_at: string | null;
  first_seen_at: string;
}

// Quality threshold for follow consideration
const QUALITY_POSTS_FOR_FOLLOW = 3;
const MIN_QUALITY_SCORE_FOR_FOLLOW = 150; // 3 posts * 50 avg score

/**
 * Upvote a quality post and track the author for potential following
 *
 * @param client - MoltbookClient instance
 * @param db - D1Database instance
 * @param post - The post to upvote
 * @param qualityScore - The engagement score (0-100) for this post
 * @param dryRun - If true, don't actually upvote
 * @returns Result with upvote status and follow suggestion
 */
export async function upvoteAndTrackAuthor(
  client: MoltbookClient,
  db: D1Database,
  post: MoltbookPost,
  qualityScore: number,
  dryRun: boolean = false
): Promise<UpvoteResult> {
  const result: UpvoteResult = {
    upvoted: false,
    followSuggestion: false,
  };

  // Check upvote budget
  if (!(await canUpvote(db))) {
    console.log('Upvote budget exhausted.');
    return result;
  }

  // Check if already upvoted this post
  const existing = await db
    .prepare('SELECT 1 FROM upvotes_given WHERE target_type = ? AND target_id = ?')
    .bind('post', safeD1Value(post.id))
    .first();

  if (existing) {
    return result; // Already upvoted
  }

  const authorName = post.author?.username || post.author?.name;
  if (!authorName) {
    return result; // No author to track
  }

  result.authorName = authorName;

  try {
    if (!dryRun) {
      const upvoteResponse = await client.upvotePost(post.id);

      // Track the upvote in database
      await db.prepare(`
        INSERT INTO upvotes_given (target_type, target_id, author_name, created_at)
        VALUES ('post', ?, ?, datetime('now'))
      `).bind(safeD1Value(post.id), safeD1Value(authorName)).run();

      await recordUpvote(db);
      result.upvoted = true;

      // Check for follow suggestion from API response
      if (upvoteResponse.suggestion && !upvoteResponse.already_following) {
        result.followSuggestion = true;
      }

      // Track author quality regardless of API suggestion
      await updateAuthorQuality(db, authorName, qualityScore);

      console.log(`Upvoted post by ${authorName} (score: ${qualityScore})`);
    } else {
      console.log(`[Dry] Would upvote post ${post.id} by ${authorName} (score: ${qualityScore})`);
      result.upvoted = true;
    }
  } catch (error) {
    console.error('Upvote failed:', error instanceof Error ? error.message : error);
  }

  return result;
}

/**
 * Update author quality score in database
 * Accumulates quality across multiple posts
 */
async function updateAuthorQuality(
  db: D1Database,
  authorName: string,
  qualityScore: number
): Promise<void> {
  const now = new Date().toISOString();

  await db.prepare(`
    INSERT INTO followed_authors (agent_name, quality_score, quality_posts, first_seen_at)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(agent_name) DO UPDATE SET
      quality_score = quality_score + excluded.quality_score,
      quality_posts = quality_posts + 1
  `).bind(safeD1Value(authorName), qualityScore, now).run();
}

/**
 * Check if any authors qualify for following (3+ quality posts)
 * Called at the end of each hour's last cycle
 *
 * @param client - MoltbookClient instance
 * @param db - D1Database instance
 * @param dryRun - If true, don't actually follow
 * @returns Array of authors followed this cycle
 */
export async function checkForFollowOpportunity(
  client: MoltbookClient,
  db: D1Database,
  dryRun: boolean = false
): Promise<string[]> {
  const followed: string[] = [];

  // Check follow budget
  if (!(await canFollow(db))) {
    return followed;
  }

  // Get authors with 3+ quality posts who we haven't followed
  const candidates = await db.prepare(`
    SELECT agent_name, quality_score, quality_posts
    FROM followed_authors
    WHERE followed_at IS NULL
      AND quality_posts >= ?
      AND quality_score >= ?
    ORDER BY quality_score DESC
    LIMIT 5
  `).bind(QUALITY_POSTS_FOR_FOLLOW, MIN_QUALITY_SCORE_FOR_FOLLOW).all<AuthorQuality>();

  for (const candidate of candidates.results ?? []) {
    // Re-check budget for each follow attempt
    if (!(await canFollow(db))) {
      break;
    }

    try {
      if (!dryRun) {
        await client.follow(candidate.agent_name);

        // Mark as followed in database
        await db.prepare(`
          UPDATE followed_authors SET followed_at = datetime('now')
          WHERE agent_name = ?
        `).bind(candidate.agent_name).run();

        await recordFollow(db);
      }

      followed.push(candidate.agent_name);
      console.log(`Followed ${candidate.agent_name} (quality: ${candidate.quality_score}, posts: ${candidate.quality_posts})`);
    } catch (error) {
      console.error(`Failed to follow ${candidate.agent_name}:`, error instanceof Error ? error.message : error);
    }
  }

  return followed;
}

/**
 * Get list of authors being tracked for quality
 *
 * @param db - D1Database instance
 * @param limit - Max authors to return
 * @returns Array of tracked authors with their scores
 */
export async function getTrackedAuthors(
  db: D1Database,
  limit: number = 20
): Promise<AuthorQuality[]> {
  const result = await db.prepare(`
    SELECT agent_name, quality_score, quality_posts, followed_at, first_seen_at
    FROM followed_authors
    ORDER BY quality_score DESC
    LIMIT ?
  `).bind(limit).all<AuthorQuality>();

  return result.results ?? [];
}

/**
 * Check if we've already upvoted a specific post
 *
 * @param db - D1Database instance
 * @param postId - The post ID to check
 * @returns True if already upvoted
 */
export async function hasUpvoted(db: D1Database, postId: string): Promise<boolean> {
  const existing = await db
    .prepare('SELECT 1 FROM upvotes_given WHERE target_type = ? AND target_id = ?')
    .bind('post', safeD1Value(postId))
    .first();

  return existing !== null;
}

/**
 * Get count of upvotes given today
 *
 * @param db - D1Database instance
 * @returns Number of upvotes given today
 */
export async function getTodayUpvoteCount(db: D1Database): Promise<number> {
  const today = new Date().toISOString().split('T')[0];

  const result = await db.prepare(`
    SELECT COUNT(*) as count
    FROM upvotes_given
    WHERE created_at >= ?
  `).bind(today).first<{ count: number }>();

  return result?.count ?? 0;
}
