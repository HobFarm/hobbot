// Daily rate limit tracking in D1

import { RATE_LIMITS } from '../config';

export interface DailyBudget {
  date: string;
  comments_used: number;
  comments_max: number;
  posts_used: number;
  posts_max: number;
  last_post_at: string | null;
  last_comment_at: string | null;
}

function getTodayDate(): string {
  return new Date().toISOString().split('T')[0];
}

export async function getTodayBudget(db: D1Database): Promise<DailyBudget> {
  const today = getTodayDate();

  // Initialize if not exists
  await db
    .prepare(
      `INSERT OR IGNORE INTO daily_budget (date, comments_used, comments_max, posts_used, posts_max)
       VALUES (?, 0, ?, 0, ?)`
    )
    .bind(today, RATE_LIMITS.COMMENTS_PER_DAY, RATE_LIMITS.POSTS_PER_DAY)
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

  if (!budget.last_post_at) {
    return Infinity;
  }

  const lastPost = new Date(budget.last_post_at);
  const now = new Date();
  const minutesSince = (now.getTime() - lastPost.getTime()) / (1000 * 60);

  return minutesSince;
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
