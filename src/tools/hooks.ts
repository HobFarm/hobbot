// Hook pipeline: pre/post execution hooks for manifest-driven tools.
// Phase 3B of hobbot-enhancement-plan.md.
//
// Hook system applies to manifest-driven tools only (the 8 Grimoire tools).
// Direct server.tool() registrations and admin tools are unaffected.

// --- Types ---

export interface HookContext {
  toolName: string
  category: string
  input: Record<string, unknown>
  startedAt: number
}

export interface PostHookContext extends HookContext {
  output: unknown
  durationMs: number
  status: 'success' | 'error'
  error?: string
}

export interface PreHookResult {
  action: 'allow' | 'deny'
  reason?: string
  rewrittenInput?: Record<string, unknown>
}

export type PreHook = (ctx: HookContext, env: unknown) => Promise<PreHookResult>
export type PostHook = (ctx: PostHookContext, env: unknown) => Promise<void>

// --- MCP result type (matches server.ts McpResult) ---

type McpResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

// --- Hook Registry ---

const PRE_HOOKS: Record<string, PreHook> = {
  // Phase 4: budget_check, rate_limit
}

const POST_HOOKS: Record<string, PostHook> = {
  'ledger_log': ledgerLogHook,
}

function resolvePreHooks(names: string[]): PreHook[] {
  return names
    .map(name => {
      const hook = PRE_HOOKS[name]
      if (!hook) console.warn(`Unknown pre-hook: ${name}`)
      return hook
    })
    .filter(Boolean) as PreHook[]
}

function resolvePostHooks(names: string[]): PostHook[] {
  return names
    .map(name => {
      const hook = POST_HOOKS[name]
      if (!hook) console.warn(`Unknown post-hook: ${name}`)
      return hook
    })
    .filter(Boolean) as PostHook[]
}

// --- Executor ---

/**
 * Wrap a tool handler with pre/post hook execution.
 *
 * Execution order:
 * 1. Run all pre-hooks sequentially. If any returns 'deny', return denial as tool response.
 * 2. Run the handler.
 * 3. Run all post-hooks in finally block (fire-and-forget, errors caught and logged).
 *
 * Fast path: no hooks declared, return handler unwrapped (zero overhead).
 */
export function wrapWithHooks(
  manifest: { name: string; category: string; hooks?: { pre?: string[]; post?: string[] } },
  handler: (params: Record<string, unknown>) => Promise<McpResult>,
  env: unknown,
): (params: Record<string, unknown>) => Promise<McpResult> {

  const preHooks = resolvePreHooks(manifest.hooks?.pre ?? [])
  const postHooks = resolvePostHooks(manifest.hooks?.post ?? [])

  if (preHooks.length === 0 && postHooks.length === 0) {
    return handler
  }

  return async (params: Record<string, unknown>): Promise<McpResult> => {
    const startedAt = Date.now()
    const ctx: HookContext = {
      toolName: manifest.name,
      category: manifest.category,
      input: params,
      startedAt,
    }

    // Pre-hooks
    for (const hook of preHooks) {
      const result = await hook(ctx, env)
      if (result.action === 'deny') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'hook_denied', reason: result.reason ?? 'Denied by pre-hook' }) }],
          isError: true,
        }
      }
      if (result.rewrittenInput) {
        params = result.rewrittenInput
        ctx.input = params
      }
    }

    // Handler
    let output: McpResult | undefined
    let status: 'success' | 'error' = 'success'
    let error: string | undefined

    try {
      output = await handler(params)
      return output
    } catch (e) {
      status = 'error'
      error = e instanceof Error ? e.message : String(e)
      throw e
    } finally {
      const postCtx: PostHookContext = {
        ...ctx,
        output,
        durationMs: Date.now() - startedAt,
        status,
        error,
      }
      for (const hook of postHooks) {
        try {
          await hook(postCtx, env)
        } catch (hookErr) {
          console.error(`Post-hook error in ${manifest.name}:`, hookErr instanceof Error ? hookErr.message : hookErr)
        }
      }
    }
  }
}

// --- Hook Implementations ---

// TODO: Add 30-day retention cleanup. Either:
// - Cron job: DELETE FROM tool_executions WHERE created_at < datetime('now', '-30 days')
// - Or hook into an existing cron phase (e.g., chat's daily session purge)
// Table grows ~8 rows per tool-use conversation turn. At 100 conversations/day
// that's ~800 rows/day, ~24K/month. Manageable but should be pruned.
async function ledgerLogHook(ctx: PostHookContext, env: unknown): Promise<void> {
  const db = (env as { HOBBOT_DB?: D1Database }).HOBBOT_DB
  if (!db) {
    console.warn('ledger_log: HOBBOT_DB not available, skipping')
    return
  }

  await db.prepare(
    `INSERT INTO tool_executions (tool_name, category, input_summary, output_summary, duration_ms, status, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    ctx.toolName,
    ctx.category,
    JSON.stringify(ctx.input).slice(0, 500),
    JSON.stringify(ctx.output).slice(0, 500),
    ctx.durationMs,
    ctx.status,
    ctx.error ?? null,
    new Date(ctx.startedAt).toISOString(),
  ).run()
}
