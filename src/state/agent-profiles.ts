// Agent profile intelligence gathering
// Tracks agent karma, followers, quality over time

import type { D1Database } from "@cloudflare/workers-types";
import type { MoltbookAgent } from "../moltbook/types";
import { hashContent } from "./audit";
import { safeD1Value } from "../utils/d1";

// Per-cycle cap on profile API fetches to prevent stacking
export const MAX_PROFILE_FETCHES_PER_CYCLE = 5;

// Don't re-fetch profiles updated within this window
const STALENESS_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Compute quality score using explicit, debuggable formula:
 * quality_score = min(100,
 *   (log10(karma + 1) * 30) +
 *   (log10(followers + 1) * 20) +
 *   (interaction_count * 10) +
 *   (avg_post_score * 0.4)
 * )
 */
function computeQualityScore(
  karma: number,
  followers: number,
  interactionCount: number,
  avgPostScore: number | null
): number {
  const karmaComponent = Math.log10(karma + 1) * 30;
  const followerComponent = Math.log10(followers + 1) * 20;
  const interactionComponent = interactionCount * 10;
  const scoreComponent = (avgPostScore ?? 0) * 0.4;

  return Math.min(100, karmaComponent + followerComponent + interactionComponent + scoreComponent);
}

/**
 * Upsert agent profile from MoltbookAgent data.
 * Uses post.author data (no API call) for basic capture.
 * Call with richer data from getProfile() for high-value authors.
 */
export async function upsertAgentProfile(
  db: D1Database,
  agent: MoltbookAgent,
  interactionScore?: number,
  platform: string = "moltbook"
): Promise<void> {
  const agentHash = await hashContent(agent.id);
  const now = new Date().toISOString();
  const username = agent.username || agent.name;
  if (!username) {
    return; // Skip agents with no identifiable name
  }
  const karma = agent.karma ?? 0;
  const followers = agent.follower_count ?? 0;

  // Check existing record for running averages
  const existing = await db
    .prepare(
      "SELECT interaction_count, avg_post_score FROM agent_profiles WHERE agent_hash = ?"
    )
    .bind(agentHash)
    .first<{ interaction_count: number; avg_post_score: number | null }>();

  const prevCount = existing?.interaction_count ?? 0;
  const prevAvg = existing?.avg_post_score ?? null;

  // Calculate new avg_post_score incrementally
  let newAvg: number | null = prevAvg;
  if (interactionScore !== undefined) {
    if (prevAvg === null) {
      newAvg = interactionScore;
    } else {
      newAvg = (prevAvg * prevCount + interactionScore) / (prevCount + 1);
    }
  }

  const newInteractionCount =
    interactionScore !== undefined ? prevCount + 1 : prevCount;
  const qualityScore = computeQualityScore(
    karma,
    followers,
    newInteractionCount,
    newAvg
  );

  await db
    .prepare(
      `INSERT INTO agent_profiles (
        agent_hash, platform, username, karma, follower_count,
        post_count, comment_count, description, agent_created_at,
        quality_score, interaction_count, avg_post_score,
        last_active_at, first_seen_at, last_updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_hash) DO UPDATE SET
        username = excluded.username,
        karma = excluded.karma,
        follower_count = excluded.follower_count,
        post_count = excluded.post_count,
        comment_count = excluded.comment_count,
        description = COALESCE(excluded.description, description),
        quality_score = excluded.quality_score,
        interaction_count = excluded.interaction_count,
        avg_post_score = excluded.avg_post_score,
        last_active_at = excluded.last_active_at,
        last_updated_at = excluded.last_updated_at`
    )
    .bind(
      agentHash,
      platform,
      username,
      safeD1Value(karma),
      safeD1Value(followers),
      safeD1Value(agent.post_count ?? 0),
      safeD1Value(agent.comment_count ?? 0),
      safeD1Value(agent.description ?? null),
      safeD1Value(agent.created_at),
      qualityScore,
      newInteractionCount,
      newAvg,
      now,
      now,
      now
    )
    .run();
}

/**
 * Update last_active_at without a full profile upsert
 */
export async function touchAgentActivity(
  db: D1Database,
  agentHash: string
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      "UPDATE agent_profiles SET last_active_at = ? WHERE agent_hash = ?"
    )
    .bind(now, agentHash)
    .run();
}

/**
 * Check if a profile needs re-fetching (stale > 24 hours)
 */
export async function isProfileStale(
  db: D1Database,
  agentId: string
): Promise<boolean> {
  const agentHash = await hashContent(agentId);
  const existing = await db
    .prepare(
      "SELECT last_updated_at FROM agent_profiles WHERE agent_hash = ?"
    )
    .bind(agentHash)
    .first<{ last_updated_at: string }>();

  if (!existing) return true;

  const lastUpdated = new Date(existing.last_updated_at).getTime();
  return Date.now() - lastUpdated > STALENESS_THRESHOLD_MS;
}

/**
 * Decay quality scores for agents inactive > staleDays.
 * Multiplies quality_score by 0.9 per staleDays period of inactivity.
 * Called from reflect phase (hourly).
 */
export async function decayStaleProfiles(
  db: D1Database,
  staleDays: number = 30
): Promise<number> {
  const cutoff = new Date(
    Date.now() - staleDays * 24 * 60 * 60 * 1000
  ).toISOString();

  const result = await db
    .prepare(
      `UPDATE agent_profiles
       SET quality_score = quality_score * 0.9
       WHERE last_active_at < ?
         AND quality_score > 1`
    )
    .bind(cutoff)
    .run();

  return result.meta.changes ?? 0;
}

/**
 * Get top quality agents
 */
export async function getTopAgents(
  db: D1Database,
  limit: number = 20
): Promise<
  Array<{
    username: string;
    karma: number;
    quality_score: number;
    interaction_count: number;
  }>
> {
  const results = await db
    .prepare(
      `SELECT username, karma, quality_score, interaction_count
       FROM agent_profiles
       ORDER BY quality_score DESC
       LIMIT ?`
    )
    .bind(limit)
    .all<{
      username: string;
      karma: number;
      quality_score: number;
      interaction_count: number;
    }>();

  return results.results ?? [];
}
