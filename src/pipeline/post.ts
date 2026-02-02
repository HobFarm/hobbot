// Submit responses to Moltbook

import type { MoltbookClient } from '../moltbook/client';
import {
  canComment,
  canPost,
  getTimeSinceLastComment,
  getTimeSinceLastPost,
  recordComment,
  recordPost,
} from '../state/budget';
import { recordEngagement } from '../state/seen';
import { RATE_LIMITS } from '../config';

export async function postComment(
  client: MoltbookClient,
  db: D1Database,
  postId: string,
  content: string,
  dryRun: boolean
): Promise<boolean> {
  // Check budget
  const hasCommentBudget = await canComment(db);
  if (!hasCommentBudget) {
    console.log('[DRY_RUN] Comment budget exhausted');
    return false;
  }

  // Check rate limit (20 seconds between comments)
  const timeSinceLastComment = await getTimeSinceLastComment(db);
  if (timeSinceLastComment < RATE_LIMITS.COMMENT_INTERVAL_SECONDS) {
    console.log(
      `[DRY_RUN] Comment rate limit not met. Wait ${
        RATE_LIMITS.COMMENT_INTERVAL_SECONDS - timeSinceLastComment
      }s`
    );
    return false;
  }

  if (dryRun) {
    console.log('[DRY_RUN] Would post comment:');
    console.log(`Post ID: ${postId}`);
    console.log(`Content: ${content}`);
    console.log('---');

    // Still update budget in dry run to simulate behavior
    await recordComment(db);
    await recordEngagement(db, postId, 'comment');
    return true;
  }

  try {
    // Actually post the comment
    await client.postComment(postId, content);
    console.log(`Posted comment to ${postId}`);

    // Update budget and engagement tracking
    await recordComment(db);
    await recordEngagement(db, postId, 'comment');

    return true;
  } catch (error) {
    console.error('Failed to post comment:', error);
    return false;
  }
}

export async function createPost(
  client: MoltbookClient,
  db: D1Database,
  title: string,
  content: string,
  submolt: string,
  dryRun: boolean
): Promise<boolean> {
  // Check budget
  const hasPostBudget = await canPost(db);
  if (!hasPostBudget) {
    console.log('[DRY_RUN] Post budget exhausted');
    return false;
  }

  // Check rate limit (30 minutes between posts)
  const timeSinceLastPost = await getTimeSinceLastPost(db);
  if (timeSinceLastPost < RATE_LIMITS.POST_INTERVAL_MINUTES) {
    console.log(
      `[DRY_RUN] Post rate limit not met. Wait ${
        RATE_LIMITS.POST_INTERVAL_MINUTES - timeSinceLastPost
      }min`
    );
    return false;
  }

  if (dryRun) {
    console.log('[DRY_RUN] Would create post:');
    console.log(`Title: ${title}`);
    console.log(`Content: ${content}`);
    console.log(`Submolt: ${submolt}`);
    console.log('---');

    // Still update budget in dry run to simulate behavior
    await recordPost(db);
    return true;
  }

  try {
    // Actually create the post
    const post = await client.createPost(title, content, submolt);
    console.log(`Created post: ${post.id}`);

    // Update budget
    await recordPost(db);

    return true;
  } catch (error) {
    console.error('Failed to create post:', error);
    return false;
  }
}
