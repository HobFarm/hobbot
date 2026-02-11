// Submolt subscription management for HobBot
// Runs during daily initialization to subscribe to relevant submolts

import type { MoltbookClient } from './client';

// Submolts HobBot should subscribe to (from SKILL document)
// These align with HobBot's expertise and community role
export const HOBBOT_SUBSCRIPTIONS = [
  'agents',           // Core agent discussion
  'buildlogs',        // Build receipts (aligns with HobFarm philosophy)
  'infrastructure',   // Agent infrastructure
  'mcp',              // MCP servers (relevant to HobBot's tooling)
  'aitools',          // AI tools
  'aisafety',         // Safety and security
  'programming',      // Technical content
  'builds',           // Shipped projects
  'tips',             // How-tos and solutions
  'hobfarm',          // Home turf
  'structured-minds', // Home turf
] as const;

export type HobBotSubmolt = typeof HOBBOT_SUBSCRIPTIONS[number];

interface SubscriptionResult {
  subscribed: string[];
  failed: string[];
  alreadySubscribed: string[];
}

/**
 * Initialize subscriptions for HobBot
 * Should be run during daily refresh at 8:00 UTC
 *
 * @param client - MoltbookClient instance
 * @param db - D1Database instance
 * @param dryRun - If true, don't actually subscribe
 * @returns Summary of subscription attempts
 */
export async function initializeSubscriptions(
  client: MoltbookClient,
  db: D1Database,
  dryRun: boolean = false
): Promise<SubscriptionResult> {
  const result: SubscriptionResult = {
    subscribed: [],
    failed: [],
    alreadySubscribed: [],
  };

  // Get current subscription status from database
  const existing = await db
    .prepare('SELECT name FROM submolts WHERE subscribed = TRUE')
    .all<{ name: string }>();

  const alreadySubscribed = new Set(existing.results?.map(r => r.name) ?? []);

  for (const submolt of HOBBOT_SUBSCRIPTIONS) {
    if (alreadySubscribed.has(submolt)) {
      result.alreadySubscribed.push(submolt);
      continue;
    }

    try {
      if (!dryRun) {
        await client.subscribe(submolt);
      }

      // Mark as subscribed in database
      const now = new Date().toISOString();

      // Update existing row if it exists
      const updateResult = await db.prepare(`
        UPDATE submolts
        SET subscribed = TRUE, subscribed_at = ?
        WHERE name = ?
      `).bind(now, submolt).run();

      // If no row existed, insert a new one
      if (updateResult.meta.changes === 0) {
        await db.prepare(`
          INSERT INTO submolts (name, description, member_count, relevance_score, subscribed, subscribed_at, updated_at)
          VALUES (?, 'Subscribed submolt', 0, 80, TRUE, ?, ?)
        `).bind(submolt, now, now).run();
      }

      result.subscribed.push(submolt);
      console.log(`Subscribed to m/${submolt}`);
    } catch (error) {
      // Don't fail the whole process for one submolt
      console.error(`Failed to subscribe to m/${submolt}:`, error instanceof Error ? error.message : error);
      result.failed.push(submolt);
    }
  }

  return result;
}

/**
 * Check if HobBot is subscribed to all target submolts
 *
 * @param db - D1Database instance
 * @returns Array of submolts not yet subscribed to
 */
export async function getMissingSubscriptions(db: D1Database): Promise<string[]> {
  const existing = await db
    .prepare('SELECT name FROM submolts WHERE subscribed = TRUE')
    .all<{ name: string }>();

  const subscribed = new Set(existing.results?.map(r => r.name) ?? []);

  return HOBBOT_SUBSCRIPTIONS.filter(s => !subscribed.has(s));
}

/**
 * Get count of subscribed submolts
 *
 * @param db - D1Database instance
 * @returns Number of submolts subscribed to
 */
export async function getSubscriptionCount(db: D1Database): Promise<number> {
  const result = await db
    .prepare('SELECT COUNT(*) as count FROM submolts WHERE subscribed = TRUE')
    .first<{ count: number }>();

  return result?.count ?? 0;
}
