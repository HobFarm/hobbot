// Token usage logging utility.
// Creates a fire-and-forget callback for callWithJsonParse's onUsage option.
// Writes to token_usage table in HOBBOT_DB.

import type { TokenUsageReport } from './call-with-json-parse'

/**
 * Create a token usage logger that writes to D1.
 * Returns a callback compatible with CallOptions.onUsage.
 * Fire-and-forget: never blocks AI calls, catches all errors silently.
 */
export function createTokenLogger(
  db: D1Database,
  worker: string,
): (usage: TokenUsageReport) => void {
  return (usage) => {
    db.prepare(
      `INSERT INTO token_usage (tool_name, model, provider, input_tokens, output_tokens, total_tokens, estimated_cost_usd, worker, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    ).bind(
      usage.taskType,
      usage.model,
      usage.provider,
      usage.inputTokens,
      usage.outputTokens,
      usage.inputTokens + usage.outputTokens,
      usage.estimatedCost || null,
      worker,
    ).run().catch(() => {}) // fire-and-forget
  }
}
