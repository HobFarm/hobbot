// Audit logging module (Phase 7)
// Append-only record of all HobBot actions

export type AuditAction =
  | 'post'
  | 'comment'
  | 'reply'
  | 'upvote'
  | 'dm'
  | 'validation_reject'
  | 'catalog'
  | 'deflection';

export type AuditOutcome =
  | 'success'
  | 'failed'
  | 'skipped'
  | 'dry_run';

/**
 * Log an action to the audit table
 */
export async function logAudit(
  db: D1Database,
  actionType: AuditAction,
  targetId: string | null,
  targetAuthor: string | null,
  contentHash: string | null,
  outcome: AuditOutcome,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  try {
    await db.prepare(`
      INSERT INTO audit_log (action_type, target_id, target_author, content_hash, outcome, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      actionType,
      targetId ?? null,
      targetAuthor ?? null,
      contentHash ?? null,
      outcome,
      JSON.stringify(metadata)
    ).run();
  } catch (error) {
    // Don't let audit logging failures break the main flow
    console.log('Audit logging failed:', error);
  }
}

/**
 * Hash content using Web Crypto API (Cloudflare Workers compatible)
 */
export async function hashContent(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
