// Daily rate limit tracking in D1

import { BUDGET, BUDGET_SPLIT, ITERATION_BUDGET_UNITS } from '../config';
import type { MetaphorFamily } from '../prompts/metaphors';

export type { MetaphorFamily };

const FAMILY_CYCLE: MetaphorFamily[] = ['geometry', 'fractal', 'agricultural', 'structural', 'journey'];

export interface DailyBudget {
  date: string;
  comments_used: number;
  comments_max: number;
  posts_used: number;
  posts_max: number;
  replies_used: number;
  replies_max: number;
  upvotes_used: number;
  upvotes_max: number;
  follows_used: number;
  follows_max: number;
  last_post_at: string | null;
  last_comment_at: string | null;
  last_reply_at: string | null;
  last_metaphor_family: MetaphorFamily | null;
}

function getTodayDate(): string {
  return new Date().toISOString().split('T')[0];
}

export async function getTodayBudget(db: D1Database): Promise<DailyBudget> {
  const today = getTodayDate();

  // Initialize if not exists
  await db
    .prepare(
      `INSERT OR IGNORE INTO daily_budget (date, comments_used, comments_max, posts_used, posts_max, replies_used, replies_max, upvotes_used, upvotes_max, follows_used, follows_max)
       VALUES (?, 0, ?, 0, ?, 0, ?, 0, ?, 0, ?)`
    )
    .bind(today, BUDGET.COMMENTS_MAX, BUDGET.POSTS_MAX, BUDGET.REPLY_MAX, BUDGET.UPVOTES_MAX, BUDGET.FOLLOWS_MAX)
    .run();

  // Fetch current budget
  const result = await db
    .prepare('SELECT * FROM daily_budget WHERE date = ?')
    .bind(today)
    .first<DailyBudget>();

  if (!result) {
    throw new Error('Failed to fetch daily budget');
  }

  return result;
}

export async function canComment(db: D1Database): Promise<boolean> {
  const budget = await getTodayBudget(db);
  return budget.comments_used < budget.comments_max;
}

export async function canPost(db: D1Database): Promise<boolean> {
  const budget = await getTodayBudget(db);
  return budget.posts_used < budget.posts_max;
}

export async function getTimeSinceLastPost(db: D1Database): Promise<number> {
  const budget = await getTodayBudget(db);

  if (budget.last_post_at) {
    const lastPost = new Date(budget.last_post_at);
    const now = new Date();
    return (now.getTime() - lastPost.getTime()) / (1000 * 60);
  }

  // New day: fall back to own_posts for cross-day cooldown
  const lastOwnPost = await db.prepare(
    `SELECT created_at FROM own_posts ORDER BY created_at DESC LIMIT 1`
  ).first<{ created_at: string }>();

  if (!lastOwnPost) {
    return Infinity; // Genuinely no posts ever
  }

  const lastPost = new Date(lastOwnPost.created_at);
  const now = new Date();
  return (now.getTime() - lastPost.getTime()) / (1000 * 60);
}

export async function getTimeSinceLastComment(db: D1Database): Promise<number> {
  const budget = await getTodayBudget(db);

  if (!budget.last_comment_at) {
    return Infinity;
  }

  const lastComment = new Date(budget.last_comment_at);
  const now = new Date();
  const secondsSince = (now.getTime() - lastComment.getTime()) / 1000;

  return secondsSince;
}

export async function recordComment(db: D1Database): Promise<void> {
  const today = getTodayDate();
  const now = new Date().toISOString();

  await db
    .prepare(
      `UPDATE daily_budget
       SET comments_used = comments_used + 1,
           last_comment_at = ?
       WHERE date = ?`
    )
    .bind(now, today)
    .run();
}

export async function recordPost(db: D1Database): Promise<void> {
  const today = getTodayDate();
  const now = new Date().toISOString();

  await db
    .prepare(
      `UPDATE daily_budget
       SET posts_used = posts_used + 1,
           last_post_at = ?
       WHERE date = ?`
    )
    .bind(now, today)
    .run();
}

export async function canReply(db: D1Database): Promise<boolean> {
  const budget = await getTodayBudget(db);
  return budget.replies_used < budget.replies_max;
}

export async function getTimeSinceLastReply(db: D1Database): Promise<number> {
  const budget = await getTodayBudget(db);

  if (!budget.last_reply_at) {
    return Infinity;
  }

  const lastReply = new Date(budget.last_reply_at);
  const now = new Date();
  const secondsSince = (now.getTime() - lastReply.getTime()) / 1000;

  return secondsSince;
}

export async function recordReply(db: D1Database): Promise<void> {
  const today = getTodayDate();
  const now = new Date().toISOString();

  await db
    .prepare(
      `UPDATE daily_budget
       SET replies_used = replies_used + 1,
           last_reply_at = ?
       WHERE date = ?`
    )
    .bind(now, today)
    .run();
}

export async function getDailyTokenSpend(db: D1Database): Promise<number> {
  const today = getTodayDate();

  const result = await db
    .prepare(`
      SELECT
        SUM(input_tokens + output_tokens) as total_tokens
      FROM usage_log
      WHERE date = ?
    `)
    .bind(today)
    .first<{ total_tokens: number | null }>();

  return result?.total_tokens || 0;
}

export async function getLastMetaphorFamily(db: D1Database): Promise<MetaphorFamily> {
  const budget = await getTodayBudget(db);
  return budget.last_metaphor_family || 'geometry';
}

export async function recordMetaphorFamily(db: D1Database, family: MetaphorFamily): Promise<void> {
  const today = getTodayDate();

  await db
    .prepare(
      `UPDATE daily_budget
       SET last_metaphor_family = ?
       WHERE date = ?`
    )
    .bind(family, today)
    .run();
}

export function getNextMetaphorFamily(lastFamily: MetaphorFamily): MetaphorFamily {
  const currentIndex = FAMILY_CYCLE.indexOf(lastFamily);
  const nextIndex = (currentIndex + 1) % FAMILY_CYCLE.length;
  return FAMILY_CYCLE[nextIndex];
}

// ============================================
// Upvote Budget Tracking
// ============================================

export async function canUpvote(db: D1Database): Promise<boolean> {
  const budget = await getTodayBudget(db);
  return budget.upvotes_used < budget.upvotes_max;
}

export async function recordUpvote(db: D1Database): Promise<void> {
  const today = getTodayDate();

  await db
    .prepare(
      `UPDATE daily_budget
       SET upvotes_used = upvotes_used + 1
       WHERE date = ?`
    )
    .bind(today)
    .run();
}

// ============================================
// Follow Budget Tracking
// ============================================

export async function canFollow(db: D1Database): Promise<boolean> {
  const budget = await getTodayBudget(db);
  return budget.follows_used < budget.follows_max;
}

export async function recordFollow(db: D1Database): Promise<void> {
  const today = getTodayDate();

  await db
    .prepare(
      `UPDATE daily_budget
       SET follows_used = follows_used + 1
       WHERE date = ?`
    )
    .bind(today)
    .run();
}

// ============================================
// Rate Limit State Tracking
// ============================================

/**
 * Check if we're currently rate-limited by the API
 * This prevents repeated 429 errors within a cooldown period
 */
export async function isRateLimited(db: D1Database): Promise<boolean> {
  const today = getTodayDate();

  const result = await db
    .prepare('SELECT rate_limited_until FROM daily_budget WHERE date = ?')
    .bind(today)
    .first<{ rate_limited_until: string | null }>();

  if (!result?.rate_limited_until) {
    return false;
  }

  const rateLimitedUntil = new Date(result.rate_limited_until);
  const now = new Date();

  return rateLimitedUntil > now;
}

/**
 * Get the rate limit expiry time if currently limited
 */
export async function getRateLimitExpiry(db: D1Database): Promise<Date | null> {
  const today = getTodayDate();

  const result = await db
    .prepare('SELECT rate_limited_until FROM daily_budget WHERE date = ?')
    .bind(today)
    .first<{ rate_limited_until: string | null }>();

  if (!result?.rate_limited_until) {
    return null;
  }

  const rateLimitedUntil = new Date(result.rate_limited_until);
  const now = new Date();

  if (rateLimitedUntil <= now) {
    return null; // Already expired
  }

  return rateLimitedUntil;
}

/**
 * Record a rate limit hit from the API
 * @param retryAfterSeconds - Number of seconds to wait before retrying
 * @param endpoint - The endpoint that was rate limited (e.g., '/posts', '/comments')
 */
export async function setRateLimitedUntil(
  db: D1Database,
  retryAfterSeconds: number,
  endpoint: string
): Promise<void> {
  const today = getTodayDate();
  const until = new Date(Date.now() + retryAfterSeconds * 1000).toISOString();

  await db
    .prepare(
      `UPDATE daily_budget
       SET rate_limited_until = ?, rate_limit_endpoint = ?
       WHERE date = ?`
    )
    .bind(until, endpoint, today)
    .run();

  console.log(`Rate limit recorded: ${endpoint} until ${until} (${retryAfterSeconds}s)`);
}

/**
 * Clear the rate limit state (e.g., after successful request)
 */
export async function clearRateLimit(db: D1Database): Promise<void> {
  const today = getTodayDate();

  await db
    .prepare(
      `UPDATE daily_budget
       SET rate_limited_until = NULL, rate_limit_endpoint = NULL
       WHERE date = ?`
    )
    .bind(today)
    .run();
}

// ============================================
// Per-Iteration Budget Allocation (40/40/20)
// ============================================

/**
 * Represents the budget allocation for a single 15-minute iteration
 * Split is 40% posts, 40% comments, 20% replies
 */
export interface IterationBudget {
  posts: number;
  comments: number;
  replies: number;
}

/**
 * Calculate the base iteration budget from the 40/40/20 split
 * @param unitsPerIteration - Total action units per iteration (default: 10)
 */
export function calculateIterationBudget(
  unitsPerIteration: number = ITERATION_BUDGET_UNITS
): IterationBudget {
  return {
    posts: Math.floor(unitsPerIteration * BUDGET_SPLIT.posts),      // 4
    comments: Math.floor(unitsPerIteration * BUDGET_SPLIT.comments), // 4
    replies: Math.floor(unitsPerIteration * BUDGET_SPLIT.replies),   // 2
  };
}

/**
 * Get the remaining iteration budget, capped by daily limits
 * Combines the per-iteration allocation with remaining daily capacity
 * @param db - D1 database instance
 * @param iterationBudget - Base iteration budget from calculateIterationBudget()
 */
export async function getRemainingIterationBudget(
  db: D1Database,
  iterationBudget: IterationBudget
): Promise<IterationBudget> {
  const daily = await getTodayBudget(db);

  return {
    // Take the minimum of iteration budget and remaining daily budget
    posts: Math.min(
      iterationBudget.posts,
      daily.posts_max - daily.posts_used
    ),
    comments: Math.min(
      iterationBudget.comments,
      daily.comments_max - daily.comments_used
    ),
    replies: Math.min(
      iterationBudget.replies,
      daily.replies_max - daily.replies_used
    ),
  };
}

/**
 * Log the current iteration budget for debugging
 */
export function logIterationBudget(budget: IterationBudget): void {
  console.log(`Iteration budget: posts=${budget.posts}, comments=${budget.comments}, replies=${budget.replies}`);
}

/**
 * Get per-phase token breakdown for the current cron cycle.
 * Queries usage_log for rows created since cycleStartIso, grouped by layer.
 */
export async function getCycleTokenBreakdown(
  db: D1Database,
  cycleStartIso: string
): Promise<Record<string, number>> {
  const rows = await db.prepare(`
    SELECT layer, SUM(input_tokens + output_tokens) as tokens
    FROM usage_log
    WHERE created_at >= ?
    GROUP BY layer
  `).bind(cycleStartIso).all<{ layer: string; tokens: number }>();

  const breakdown: Record<string, number> = {};
  for (const row of rows.results ?? []) {
    breakdown[row.layer] = row.tokens;
  }
  return breakdown;
}

// ============================================
// Subrequest counter (Cloudflare Workers limit: 1,000 per invocation)
// Module-level counter resets each cron invocation via resetSubrequestCount()
// ============================================

const SUBREQUEST_WARN = 800;
const SUBREQUEST_CRITICAL = 900;

let subrequestCount = 0;

export function resetSubrequestCount(): void {
  subrequestCount = 0;
}

export function incrementSubrequestCount(amount: number = 1): void {
  subrequestCount += amount;
  if (subrequestCount === SUBREQUEST_WARN) {
    console.warn(`subrequest_warning: ${SUBREQUEST_WARN}/1000 reached`);
  } else if (subrequestCount === SUBREQUEST_CRITICAL) {
    console.warn(`subrequest_critical: ${SUBREQUEST_CRITICAL}/1000 reached`);
  }
}

export function getSubrequestCount(): number {
  return subrequestCount;
}

export function isNearSubrequestLimit(): boolean {
  return subrequestCount >= SUBREQUEST_CRITICAL;
}
