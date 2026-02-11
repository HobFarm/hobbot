// Submit responses to Moltbook

import { MoltbookClient, RateLimitError } from '../moltbook/client';
import {
  canComment,
  canPost,
  getTimeSinceLastComment,
  getTimeSinceLastPost,
  recordComment,
  recordPost,
  setRateLimitedUntil,
} from '../state/budget';
import { recordEngagement } from '../state/seen';
import { logAudit, hashContent } from '../state/audit';
import { RATE_LIMITS } from '../config';

// Safety net: block leaked internal process language from becoming visible comments
const BANNED_OUTPUT_PHRASES = [
  'skip',
  'agent instructions detected',
  'pattern cataloged',
  'cataloged.',
  'commands targeting',
  'not executed here',
  'detection:',
  'classification:',
  'confidence:',
  'no action taken',
  'logged',
  'flagged for review',
  'catalog-only',
  'filed.',
  'added to collection',
  'pattern collected',
];

export function shouldPost(content: string): boolean {
  if (!content || content.trim() === '') return false;
  const lower = content.toLowerCase().trim();
  if (lower.length < 120) {
    for (const phrase of BANNED_OUTPUT_PHRASES) {
      if (lower.includes(phrase)) return false;
    }
  }
  return true;
}

export async function postComment(
  client: MoltbookClient,
  db: D1Database,
  postId: string,
  content: string,
  dryRun: boolean
): Promise<boolean> {
  // Safety net: block leaked internal output
  if (!shouldPost(content)) {
    console.log('[Safety net] Blocked leaked internal output.');
    return false;
  }

  // Check budget
  const hasCommentBudget = await canComment(db);
  if (!hasCommentBudget) {
    console.log("[Post] No budget remaining.");
    return false;
  }

  // Check rate limit (20 seconds between comments)
  const timeSinceLastComment = await getTimeSinceLastComment(db);
  if (timeSinceLastComment < RATE_LIMITS.COMMENT_INTERVAL_SECONDS) {
    console.log(
      `[Dry] Waiting. ${
        RATE_LIMITS.COMMENT_INTERVAL_SECONDS - timeSinceLastComment
      }s stillness.`
    );
    return false;
  }

  // Hash content for audit (Phase 7)
  const contentHash = await hashContent(content);

  if (dryRun) {
    console.log('[Dry] Would respond:');
    console.log(`Post ID: ${postId}`);
    console.log(`Content: ${content}`);
    console.log('---');

    // Log audit for dry run
    await logAudit(db, 'comment', postId, null, contentHash, 'dry_run');

    // Still update budget in dry run to simulate behavior
    await recordComment(db);
    await recordEngagement(db, postId, 'comment');
    return true;
  }

  try {
    // Actually post the comment
    await client.postComment(postId, content);
    console.log('Responded.');

    // Log audit for success
    await logAudit(db, 'comment', postId, null, contentHash, 'success');

    // Update budget and engagement tracking
    await recordComment(db);
    await recordEngagement(db, postId, 'comment');

    return true;
  } catch (error) {
    // Log audit for failure
    await logAudit(db, 'comment', postId, null, contentHash, 'failed', {
      error: error instanceof Error ? error.message : String(error)
    });

    if (error instanceof RateLimitError) {
      console.error(`Pushed too hard. ${error.retryAfter ? `Wait ${error.retryAfter}s.` : 'Wait unknown.'}`);
      // Persist rate-limit state to avoid repeated 429s
      await setRateLimitedUntil(db, error.retryAfter ?? 300, '/comments');
    } else {
      console.error('Response failed:', error);
    }
    return false;
  }
}

/**
 * Track a post in own_posts for dedup and self-referencing.
 * Uses INSERT OR IGNORE so duplicate post_ids are silently skipped.
 */
export async function trackOwnPost(
  db: D1Database,
  postId: string,
  submolt: string,
  title: string,
  titleHash: string,
  decisionLog?: string
): Promise<void> {
  try {
    await db.prepare(`
      INSERT OR IGNORE INTO own_posts (post_id, submolt, title, title_hash, created_at, decision_log)
      VALUES (?, ?, ?, ?, datetime('now'), ?)
    `).bind(postId, submolt, title, titleHash, decisionLog ?? null).run();
  } catch (err) {
    // Non-fatal: post was already created on Moltbook
    console.log('own_posts tracking failed:', err);
  }
}

export async function createPost(
  client: MoltbookClient,
  db: D1Database,
  title: string,
  content: string,
  submolt: string,
  dryRun: boolean,
  options?: { decisionLog?: string }
): Promise<{ success: boolean; post_id?: string }> {
  // Check budget
  const hasPostBudget = await canPost(db);
  if (!hasPostBudget) {
    console.log("[Post] No budget remaining.");
    return { success: false };
  }

  // Check rate limit (30 minutes between posts)
  const timeSinceLastPost = await getTimeSinceLastPost(db);
  if (timeSinceLastPost < RATE_LIMITS.POST_INTERVAL_MINUTES) {
    console.log(
      `[Dry] Waiting. ${
        RATE_LIMITS.POST_INTERVAL_MINUTES - timeSinceLastPost
      }min stillness.`
    );
    return { success: false };
  }

  // Hash content for audit (Phase 7)
  const contentHash = await hashContent(`${title}\n${content}`);
  const titleHash = await hashContent(title);

  // Check for recent duplicate (same title hash across ALL submolts within 24 hours)
  const duplicateCheck = await db.prepare(`
    SELECT post_id, submolt, created_at FROM own_posts
    WHERE title_hash = ?
      AND created_at > datetime('now', '-24 hours')
    LIMIT 1
  `).bind(titleHash).first<{ post_id: string; submolt: string; created_at: string }>();

  if (duplicateCheck) {
    console.log(`Dedup: "${title}" already posted to m/${duplicateCheck.submolt} (${duplicateCheck.post_id}). Skipping.`);
    await logAudit(db, 'post', duplicateCheck.post_id, null, contentHash, 'skipped', {
      reason: 'duplicate_title',
      submolt,
      title
    });
    return { success: false };
  }

  // Live feed verification: check if same title already exists on Moltbook
  try {
    const recentFeed = await client.getSubmoltFeed(submolt, 'new', 10);
    const feedDuplicate = recentFeed.find(p =>
      p.title === title &&
      (p.author?.name?.toLowerCase() === 'h0bbot' ||
       p.author?.username?.toLowerCase() === 'h0bbot')
    );
    if (feedDuplicate) {
      console.log(`Feed dedup: "${title}" already live in m/${submolt} (${feedDuplicate.id}). Skipping.`);
      await logAudit(db, 'post', feedDuplicate.id, null, contentHash, 'skipped', {
        reason: 'feed_duplicate',
        submolt,
        title
      });
      // Also track it in own_posts if missing (backfill)
      await trackOwnPost(db, feedDuplicate.id, submolt, title, titleHash);
      return { success: false };
    }
  } catch (err) {
    // Non-blocking: if feed check fails, fall through to normal post flow
    console.log('Feed dedup check failed:', err);
  }

  if (dryRun) {
    console.log('[Dry] Would post:');
    console.log(`Title: ${title}`);
    console.log(`Content: ${content}`);
    console.log(`Submolt: ${submolt}`);
    console.log('---');

    // Log audit for dry run
    await logAudit(db, 'post', null, null, contentHash, 'dry_run', { submolt, title });

    // Still update budget in dry run to simulate behavior
    await recordPost(db);
    return { success: true };
  }

  try {
    // Actually create the post
    const post = await client.createPost(title, content, submolt);
    console.log('Posted.');

    // Log audit for success
    await logAudit(db, 'post', post.id, null, contentHash, 'success', { submolt, title });

    // Update budget
    await recordPost(db);

    // Track in own_posts immediately (atomic with post creation)
    await trackOwnPost(db, post.id, submolt, title, titleHash, options?.decisionLog);

    return { success: true, post_id: post.id };
  } catch (error) {
    // Log audit for failure
    await logAudit(db, 'post', null, null, contentHash, 'failed', {
      submolt,
      title,
      error: error instanceof Error ? error.message : String(error)
    });

    if (error instanceof RateLimitError) {
      const minCooldown = RATE_LIMITS.POST_INTERVAL_MINUTES * 60;
      const cooldown = Math.max(error.retryAfter ?? 0, minCooldown);
      console.error(`Pushed too hard. Post denied. Cooling ${cooldown}s.`);
      // Persist rate-limit state to avoid repeated 429s (floor to POST_INTERVAL_MINUTES)
      await setRateLimitedUntil(db, cooldown, '/posts');
    } else {
      console.error('Post failed:', error);
    }
    return { success: false };
  }
}

/**
 * Record an interaction outcome for later reflection phase tracking
 */
export async function recordInteractionOutcome(
  db: D1Database,
  postId: string,
  action: 'comment' | 'post' | 'reply',
  targetAgentHash: string | null,
  context: {
    submolt?: string;
    topicSignals?: string[];
    metaphorFamily?: string;
    shapeClassification?: string;
    auditId?: number;
  }
): Promise<void> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000); // 3 days

  try {
    await db.prepare(`
      INSERT INTO interaction_outcomes (
        audit_id, post_id, hobbot_action, target_agent_hash,
        submolt, topic_signals, metaphor_family, shape_classification,
        created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      context.auditId || null,
      postId,
      action,
      targetAgentHash,
      context.submolt || null,
      context.topicSignals ? JSON.stringify(context.topicSignals) : null,
      context.metaphorFamily || null,
      context.shapeClassification || null,
      now.toISOString(),
      expiresAt.toISOString()
    ).run();
  } catch (error) {
    // Don't let outcome recording failures break the main flow
    console.log('Outcome recording failed:', error);
  }
}
