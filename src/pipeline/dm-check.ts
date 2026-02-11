// DM checking and notification pipeline
// Monitors direct messages and flags requests for human approval

import type { MoltbookClient } from '../moltbook/client';
import type { DMRequest } from '../moltbook/types';
import { safeD1Value } from '../utils/d1';

export interface DMCheckResult {
  hasActivity: boolean;
  pendingRequests: number;
  unreadMessages: number;
  humanNotificationNeeded: boolean;
  requestsForHuman: DMRequest[];
}

type DMRequestStatus = 'pending' | 'approved' | 'rejected' | 'human_notified';

interface StoredDMRequest {
  conversation_id: string;
  from_agent: string;
  message: string;
  received_at: string;
  status: DMRequestStatus;
  human_notified_at: string | null;
}

/**
 * Check DMs and determine what needs human attention
 * Should be called at the start of each cron cycle
 *
 * @param client - MoltbookClient instance
 * @param db - D1Database instance
 * @returns Summary of DM activity
 */
export async function checkDMs(
  client: MoltbookClient,
  db: D1Database
): Promise<DMCheckResult> {
  const result: DMCheckResult = {
    hasActivity: false,
    pendingRequests: 0,
    unreadMessages: 0,
    humanNotificationNeeded: false,
    requestsForHuman: [],
  };

  try {
    const dmCheck = await client.checkDMs();

    if (!dmCheck.has_activity) {
      return result;
    }

    result.hasActivity = true;
    result.pendingRequests = dmCheck.requests?.count ?? 0;
    result.unreadMessages = dmCheck.messages?.total_unread ?? 0;

    // Process pending requests - these need human approval
    if (dmCheck.requests && dmCheck.requests.count > 0) {
      for (const request of dmCheck.requests.items) {
        // Check if we've already stored this request
        const existing = await db
          .prepare('SELECT status FROM dm_requests WHERE conversation_id = ?')
          .bind(request.conversation_id)
          .first<{ status: DMRequestStatus }>();

        if (!existing) {
          // New request - store and flag for human
          await db.prepare(`
            INSERT INTO dm_requests (conversation_id, from_agent, message, received_at, status)
            VALUES (?, ?, ?, ?, 'pending')
          `).bind(
            safeD1Value(request.conversation_id),
            safeD1Value(request.from),
            safeD1Value(request.message),
            safeD1Value(request.created_at)
          ).run();

          result.requestsForHuman.push(request);
          result.humanNotificationNeeded = true;

          console.log(`New DM request from ${request.from}: "${request.message.slice(0, 50)}..."`);
        }
      }
    }

    // Log DM activity summary
    if (result.unreadMessages > 0) {
      console.log(`DM activity: ${result.unreadMessages} unread messages`);
    }
    if (result.pendingRequests > 0) {
      console.log(`DM activity: ${result.pendingRequests} pending requests`);
    }

  } catch (error) {
    console.error('DM check failed:', error instanceof Error ? error.message : error);
  }

  return result;
}

/**
 * Get summary of DM requests needing human attention
 * Can be used for notification systems
 *
 * @param db - D1Database instance
 * @returns Formatted string summary of pending requests
 */
export async function getHumanNotificationSummary(db: D1Database): Promise<string> {
  const pending = await db.prepare(`
    SELECT from_agent, message, received_at
    FROM dm_requests
    WHERE status = 'pending'
    ORDER BY received_at DESC
    LIMIT 10
  `).all<{ from_agent: string; message: string; received_at: string }>();

  if (!pending.results || pending.results.length === 0) {
    return '';
  }

  const lines = pending.results.map(r =>
    `- ${r.from_agent}: "${r.message.slice(0, 100)}${r.message.length > 100 ? '...' : ''}"`
  );

  return `DM requests awaiting approval:\n${lines.join('\n')}`;
}

/**
 * Get all pending DM requests
 *
 * @param db - D1Database instance
 * @returns Array of pending requests
 */
export async function getPendingDMRequests(db: D1Database): Promise<StoredDMRequest[]> {
  const result = await db.prepare(`
    SELECT conversation_id, from_agent, message, received_at, status, human_notified_at
    FROM dm_requests
    WHERE status = 'pending'
    ORDER BY received_at DESC
  `).all<StoredDMRequest>();

  return result.results ?? [];
}

/**
 * Mark a DM request as human-notified
 *
 * @param db - D1Database instance
 * @param conversationId - The conversation ID to update
 */
export async function markDMRequestNotified(db: D1Database, conversationId: string): Promise<void> {
  await db.prepare(`
    UPDATE dm_requests
    SET status = 'human_notified', human_notified_at = datetime('now')
    WHERE conversation_id = ?
  `).bind(conversationId).run();
}

/**
 * Update DM request status after human decision
 *
 * @param db - D1Database instance
 * @param conversationId - The conversation ID to update
 * @param approved - Whether the request was approved
 */
export async function updateDMRequestStatus(
  db: D1Database,
  conversationId: string,
  approved: boolean
): Promise<void> {
  const status: DMRequestStatus = approved ? 'approved' : 'rejected';

  await db.prepare(`
    UPDATE dm_requests
    SET status = ?
    WHERE conversation_id = ?
  `).bind(status, conversationId).run();
}

/**
 * Get count of pending DM requests
 *
 * @param db - D1Database instance
 * @returns Number of pending requests
 */
export async function getPendingDMCount(db: D1Database): Promise<number> {
  const result = await db.prepare(`
    SELECT COUNT(*) as count
    FROM dm_requests
    WHERE status = 'pending'
  `).first<{ count: number }>();

  return result?.count ?? 0;
}
