// Admin MCP tools: system health, data inspection, model/config introspection.
// All read-only. Registered on the gateway MCP server alongside Grimoire tools.
// Phase 2A of hobbot-enhancement-plan.md.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { MODELS, AVAILABLE_WORKERS_AI } from '../models'
import type { TaskType, TaskConfig } from '../models'
import type { Env } from '../index'
import { searchItems, getItemMetadata, getItemViews, fetchTextPreview, buildDownloadUrl, IATimeoutError } from '../clients/archive-org'

function text(data: unknown) {
  return { content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] }
}

export function registerAdminTools(server: McpServer, env: Env) {

  // ─── 1. admin_system_status ───────────────────────────────────────

  server.tool(
    'admin_system_status',
    'Health check across all HobBot workers. Pings each child worker via Service Binding and reports response time. Use this to verify all workers are running.',
    {},
    async () => {
      const workers: { name: string; status: string; responseMs: number; detail?: string }[] = []
      const now = Date.now()

      // Grimoire: Fetcher, hit GET /health
      try {
        const start = Date.now()
        const resp = await Promise.race([
          env.GRIMOIRE.fetch('https://grimoire/health'),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
        ])
        workers.push({ name: 'grimoire', status: resp.ok ? 'healthy' : `http_${resp.status}`, responseMs: Date.now() - start })
      } catch (e) {
        workers.push({ name: 'grimoire', status: 'error', responseMs: Date.now() - now, detail: (e as Error).message })
      }

      // Chat: Fetcher, hit GET /
      try {
        const start = Date.now()
        const resp = await Promise.race([
          env.HOBBOT_CHAT.fetch('https://hobbot-chat/'),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
        ])
        workers.push({ name: 'hobbot-chat', status: resp.ok ? 'healthy' : `http_${resp.status}`, responseMs: Date.now() - start })
      } catch (e) {
        workers.push({ name: 'hobbot-chat', status: 'error', responseMs: Date.now() - now, detail: (e as Error).message })
      }

      // Custodian: RPC, call listKnowledgeRequests (lightweight D1 query)
      try {
        const start = Date.now()
        await Promise.race([
          (env.HOBBOT_CUSTODIAN as unknown as { listKnowledgeRequests(s: string): Promise<unknown> }).listKnowledgeRequests('pending'),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
        ])
        workers.push({ name: 'hobbot-custodian', status: 'healthy', responseMs: Date.now() - start })
      } catch (e) {
        workers.push({ name: 'hobbot-custodian', status: 'error', responseMs: Date.now() - now, detail: (e as Error).message })
      }

      // Pipeline: RPC - no lightweight method available, try fetcher health
      try {
        const start = Date.now()
        const resp = await Promise.race([
          (env.HOBBOT_PIPELINE as unknown as Fetcher).fetch('https://hobbot-pipeline/'),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
        ])
        workers.push({ name: 'hobbot-pipeline', status: resp.ok ? 'healthy' : `http_${resp.status}`, responseMs: Date.now() - start })
      } catch (e) {
        workers.push({ name: 'hobbot-pipeline', status: 'error', responseMs: Date.now() - now, detail: (e as Error).message })
      }

      return text({ workers, timestamp: new Date().toISOString() })
    },
  )

  // ─── 2. admin_provider_health ─────────────────────────────────────

  server.tool(
    'admin_provider_health',
    'Circuit breaker state for AI providers. Shows which providers are healthy vs in cooldown. Reads from PROVIDER_HEALTH KV namespace. Empty result means all providers are healthy (no failures recorded).',
    {
      provider: z.string().optional().describe('Filter to keys containing this string (e.g. "dashscope" or "nemotron")'),
    },
    async ({ provider }) => {
      if (!env.PROVIDER_HEALTH) return text({ providers: [], note: 'PROVIDER_HEALTH KV not bound' })

      const prefix = 'provider:health:'
      const listed = await env.PROVIDER_HEALTH.list({ prefix, limit: 100 })
      const providers: { key: string; state: string; failures: number; lastFailure: string | null }[] = []

      for (const entry of listed.keys) {
        if (provider && !entry.name.includes(provider)) continue
        const raw = await env.PROVIDER_HEALTH.get(entry.name)
        if (!raw) continue
        const health = JSON.parse(raw) as { failures: number; lastFailure: number }
        const windowMs = 5 * 60 * 1000
        const inWindow = Date.now() - health.lastFailure < windowMs
        const state = inWindow && health.failures >= 3 ? 'cooldown' : 'healthy'
        providers.push({
          key: entry.name.replace(prefix, ''),
          state,
          failures: health.failures,
          lastFailure: health.lastFailure ? new Date(health.lastFailure).toISOString() : null,
        })
      }

      return text({ providers, scannedKeys: listed.keys.length })
    },
  )

  // ─── 3. admin_queue_status ────────────────────────────────────────

  server.tool(
    'admin_queue_status',
    'Queue processing status from the Grimoire execution_log and failed_operations tables. Shows recent phase throughput, error rates, and DLQ failures. Cloudflare Queues do not expose pending counts directly.',
    {
      hours: z.number().min(1).max(168).default(24).describe('Look-back window in hours (default 24)'),
    },
    async ({ hours }) => {
      const db = env.GRIMOIRE_DB

      // Phase throughput from execution_log
      const phaseStats = await db.prepare(`
        SELECT phase,
               count(*) as runs,
               sum(items_processed) as total_items,
               sum(errors) as total_errors,
               max(completed_at) as last_run,
               sum(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successes
        FROM execution_log
        WHERE completed_at > datetime('now', '-' || ? || ' hours')
        GROUP BY phase
        ORDER BY last_run DESC
      `).bind(hours).all()

      // DLQ failures
      const dlqStats = await db.prepare(`
        SELECT queue, count(*) as count, max(created_at) as latest
        FROM failed_operations
        WHERE created_at > datetime('now', '-' || ? || ' hours')
        GROUP BY queue
      `).bind(hours).all()

      return text({
        windowHours: hours,
        phases: phaseStats.results,
        dlqFailures: dlqStats.results,
        note: 'Cloudflare Queues do not expose pending depth. Phase stats from grimoire execution_log. Pipeline and custodian crons do not write to execution_log (observability gap).',
      })
    },
  )

  // ─── 4. admin_cron_status ─────────────────────────────────────────

  server.tool(
    'admin_cron_status',
    'Cron schedule definitions and last execution data for all workers. Grimoire runtime data from D1 execution_log. Pipeline and custodian runtime data from PROVIDER_HEALTH KV (cron:last:* keys). Chat has no runtime tracking.',
    {},
    async () => {
      // Static schedules from wrangler.toml
      const schedules = [
        { worker: 'grimoire', schedule: '*/15 * * * *', description: '6-phase queue feeder (classify, vectorize, harmonics, arrangements, register, correspondences)' },
        { worker: 'hobbot-pipeline', schedule: '0 */6 * * *', description: 'Chunk enrichment, SF outcomes, RSS ingest queue' },
        { worker: 'hobbot-pipeline', schedule: '0 5 * * *', description: 'Blog bridge (scan for candidates)' },
        { worker: 'hobbot-pipeline', schedule: '0 8 * * *', description: 'Blog compose pipeline' },
        { worker: 'hobbot-custodian', schedule: '0 */6 * * *', description: 'Integrity scan, RSS harvest, conductor, archive-org agent' },
        { worker: 'hobbot-custodian', schedule: '0 0 * * 1', description: 'Evolve report (Monday midnight)' },
        { worker: 'hobbot-custodian', schedule: '0 3 * * 3', description: 'Wikidata harvest + correspondences (Wednesday 3am)' },
        { worker: 'hobbot-chat', schedule: '0 4 * * *', description: 'Session purge (30 day retention)' },
      ]

      // Grimoire runtime data from D1 execution_log (last run per phase)
      const grimoireRuns = await env.GRIMOIRE_DB.prepare(`
        SELECT phase, completed_at, items_processed, errors, success,
               CAST((julianday(completed_at) - julianday(started_at)) * 86400000 AS INTEGER) as duration_ms
        FROM execution_log
        WHERE id IN (
          SELECT MAX(id) FROM execution_log GROUP BY phase
        )
        ORDER BY completed_at DESC
      `).all()

      // Pipeline and custodian runtime data from KV
      const kvRuns: Record<string, unknown>[] = []
      if (env.PROVIDER_HEALTH) {
        for (const prefix of ['cron:last:hobbot-pipeline:', 'cron:last:hobbot-custodian:']) {
          const listed = await env.PROVIDER_HEALTH.list({ prefix, limit: 50 })
          for (const key of listed.keys) {
            const raw = await env.PROVIDER_HEALTH.get(key.name)
            if (raw) {
              try { kvRuns.push(JSON.parse(raw)) } catch { /* skip malformed */ }
            }
          }
        }
      }

      return text({
        schedules,
        grimoireLastRuns: grimoireRuns.results,
        pipelineAndCustodianLastRuns: kvRuns,
      })
    },
  )

  // ─── 5. admin_d1_stats ────────────────────────────────────────────

  server.tool(
    'admin_d1_stats',
    'Row counts for all tables in a D1 database. Use this to check data volumes, verify ingestion progress, or spot anomalies in table sizes. Available databases: grimoire, hobbot.',
    {
      database: z.enum(['grimoire', 'hobbot']).default('grimoire').describe('Which D1 database to query'),
    },
    async ({ database }) => {
      const db = database === 'hobbot' ? env.HOBBOT_DB : env.GRIMOIRE_DB

      const tablesResult = await db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' ORDER BY name`
      ).all<{ name: string }>()

      const tables = tablesResult.results.map(r => r.name)
      const counts: { name: string; rowCount: number }[] = []

      // Batch counts in groups of 5 to stay within D1 CPU limits
      for (let i = 0; i < tables.length; i += 5) {
        const batch = tables.slice(i, i + 5)
        const stmts = batch.map(t => db.prepare(`SELECT '${t}' as tbl, count(*) as cnt FROM "${t}"`))
        const results = await db.batch(stmts)
        for (const r of results) {
          const row = r.results[0] as { tbl: string; cnt: number } | undefined
          if (row) counts.push({ name: row.tbl, rowCount: row.cnt })
        }
      }

      counts.sort((a, b) => b.rowCount - a.rowCount)
      return text({ database, tables: counts, totalTables: counts.length })
    },
  )

  // ─── 6. admin_d1_query ────────────────────────────────────────────

  server.tool(
    'admin_d1_query',
    'Run a read-only SQL query against a D1 database. SELECT statements only. Powerful tool for ad-hoc inspection: atom distributions, enrichment progress, correspondence analysis, schema exploration. Auto-appends LIMIT 100 if no LIMIT clause present. Available databases: grimoire, hobbot.',
    {
      database: z.enum(['grimoire', 'hobbot']).default('grimoire').describe('Which D1 database'),
      sql: z.string().describe('SQL SELECT query'),
      params: z.array(z.union([z.string(), z.number(), z.null()])).optional().describe('Bind parameters for ? placeholders'),
    },
    async ({ database, sql, params }) => {
      const trimmed = sql.trim()

      // Validate SELECT-only
      if (!/^SELECT\b/i.test(trimmed) && !/^PRAGMA\b/i.test(trimmed) && !/^WITH\b/i.test(trimmed) && !/^EXPLAIN\b/i.test(trimmed)) {
        return text({ error: 'Only SELECT, PRAGMA, WITH, and EXPLAIN statements are allowed.' })
      }

      // Reject chained statements
      const noStrings = trimmed.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '')
      if (noStrings.includes(';') && noStrings.indexOf(';') < noStrings.length - 1) {
        return text({ error: 'Multiple statements not allowed. Use a single SELECT query.' })
      }

      // Reject mutation keywords even inside CTEs
      const upper = noStrings.toUpperCase()
      for (const keyword of ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'ATTACH', 'DETACH', 'REPLACE', 'VACUUM', 'REINDEX']) {
        if (new RegExp(`\\b${keyword}\\b`).test(upper)) {
          return text({ error: `Statement contains disallowed keyword: ${keyword}` })
        }
      }

      // Auto-append LIMIT if missing
      let finalSql = trimmed.replace(/;$/, '')
      if (!/\bLIMIT\b/i.test(finalSql)) {
        finalSql += ' LIMIT 100'
      }

      const db = database === 'hobbot' ? env.HOBBOT_DB : env.GRIMOIRE_DB
      const stmt = params && params.length > 0
        ? db.prepare(finalSql).bind(...params)
        : db.prepare(finalSql)

      const result = await stmt.all()
      const columns = result.results.length > 0 ? Object.keys(result.results[0] as Record<string, unknown>) : []

      return text({
        columns,
        rows: result.results,
        rowCount: result.results.length,
        meta: { duration: result.meta?.duration },
      })
    },
  )

  // ─── 7. admin_kv_list ─────────────────────────────────────────────

  server.tool(
    'admin_kv_list',
    'List keys in a KV namespace with optional prefix filter. Can also read a specific key value. Available namespaces: PROVIDER_HEALTH.',
    {
      prefix: z.string().optional().describe('Key prefix filter'),
      key: z.string().optional().describe('If provided, reads this specific key value instead of listing'),
      limit: z.number().min(1).max(200).default(50).describe('Max keys to return when listing'),
    },
    async ({ prefix, key, limit }) => {
      if (!env.PROVIDER_HEALTH) return text({ error: 'No KV namespaces available on gateway' })

      // Single key read
      if (key) {
        const value = await env.PROVIDER_HEALTH.get(key)
        if (value === null) return text({ key, found: false })
        try {
          return text({ key, found: true, value: JSON.parse(value) })
        } catch {
          return text({ key, found: true, value })
        }
      }

      // List keys
      const listed = await env.PROVIDER_HEALTH.list({ prefix, limit })
      const keys = listed.keys.map(k => ({
        name: k.name,
        expiration: k.expiration ? new Date(k.expiration * 1000).toISOString() : null,
      }))

      return text({
        namespace: 'PROVIDER_HEALTH',
        keys,
        count: keys.length,
        truncated: !listed.list_complete,
      })
    },
  )

  // ─── 8. admin_model_registry ──────────────────────────────────────

  server.tool(
    'admin_model_registry',
    'Current model assignments from the shared MODELS registry. Shows every task type with its primary model and fallback chain. Filter by task prefix to see specific worker assignments (e.g. "chat", "pipeline", "custodian").',
    {
      taskPrefix: z.string().optional().describe('Filter by prefix (e.g. "chat", "pipeline", "custodian")'),
    },
    async ({ taskPrefix }) => {
      const entries = Object.entries(MODELS) as [TaskType, TaskConfig][]
      const filtered = taskPrefix
        ? entries.filter(([key]) => key.startsWith(taskPrefix))
        : entries

      const tasks = filtered.map(([taskKey, config]) => ({
        taskKey,
        primary: { provider: config.primary.provider, model: config.primary.model, options: config.primary.options },
        fallbacks: config.fallbacks.map(f => ({ provider: f.provider, model: f.model, options: f.options })),
      }))

      return text({ tasks, totalTasks: entries.length, filtered: tasks.length })
    },
  )

  // ─── 9. admin_worker_bindings ─────────────────────────────────────

  // Static binding map from wrangler.toml files. Update when bindings change.
  const WORKER_BINDINGS: Record<string, { d1: string[]; kv: string[]; r2: string[]; queues: string[]; ai: boolean; services: string[]; secrets: string[] }> = {
    'hobbot-worker': {
      d1: ['GRIMOIRE_DB', 'HOBBOT_DB'],
      kv: ['PROVIDER_HEALTH'],
      r2: [],
      queues: [],
      ai: false,
      services: ['GRIMOIRE', 'HOBBOT_CHAT', 'HOBBOT_CUSTODIAN', 'HOBBOT_PIPELINE'],
      secrets: ['SERVICE_TOKENS'],
    },
    'hobbot-pipeline': {
      d1: ['GRIMOIRE_DB', 'HOBBOT_DB'],
      kv: ['PROVIDER_HEALTH'],
      r2: ['R2'],
      queues: [],
      ai: true,
      services: ['GRIMOIRE'],
      secrets: ['GEMINI_API_KEY', 'INTERNAL_SECRET', 'GITHUB_TOKEN'],
    },
    'hobbot-custodian': {
      d1: ['GRIMOIRE_DB', 'HOBBOT_DB'],
      kv: ['PROVIDER_HEALTH'],
      r2: [],
      queues: [],
      ai: true,
      services: ['GRIMOIRE'],
      secrets: ['SERVICE_TOKENS', 'GEMINI_API_KEY', 'AI_GATEWAY_TOKEN'],
    },
    'hobbot-chat': {
      d1: ['GRIMOIRE_DB', 'HOBBOT_DB'],
      kv: ['PROVIDER_HEALTH'],
      r2: [],
      queues: [],
      ai: true,
      services: [],
      secrets: ['ANTHROPIC_API_KEY', 'AI_GATEWAY_TOKEN', 'DASHSCOPE_API_KEY'],
    },
    'grimoire': {
      d1: ['DB'],
      kv: ['PROVIDER_HEALTH'],
      r2: ['R2'],
      queues: ['CLASSIFY_QUEUE', 'DISCOVERY_QUEUE', 'VECTORIZE_QUEUE', 'ENRICH_QUEUE'],
      ai: true,
      services: [],
      secrets: ['GEMINI_API_KEY', 'AI_GATEWAY_TOKEN', 'SERVICE_TOKENS'],
    },
  }

  server.tool(
    'admin_worker_bindings',
    'List all bindings (D1, KV, R2, Queue, AI, Service, Secrets) for a HobBot worker. Static from wrangler.toml. Available workers: hobbot-worker, hobbot-pipeline, hobbot-custodian, hobbot-chat, grimoire.',
    {
      worker: z.enum(['hobbot-worker', 'hobbot-pipeline', 'hobbot-custodian', 'hobbot-chat', 'grimoire']).describe('Worker name'),
    },
    async ({ worker }) => {
      const bindings = WORKER_BINDINGS[worker]
      if (!bindings) return text({ error: `Unknown worker: ${worker}` })
      return text({ worker, bindings })
    },
  )

  // ─── 10. admin_workers_ai_catalog ─────────────────────────────────

  server.tool(
    'admin_workers_ai_catalog',
    'Workers AI models cataloged in AVAILABLE_WORKERS_AI. Shows which are assigned to task types and which are available for future use. Verify model availability at https://developers.cloudflare.com/workers-ai/models/',
    {},
    async () => {
      // Build set of all model strings currently in MODELS
      const assignedModels = new Map<string, string[]>()
      for (const [taskKey, config] of Object.entries(MODELS) as [TaskType, TaskConfig][]) {
        const models = [config.primary, ...config.fallbacks]
        for (const m of models) {
          if (!assignedModels.has(m.model)) assignedModels.set(m.model, [])
          assignedModels.get(m.model)!.push(taskKey)
        }
      }

      const available = Object.entries(AVAILABLE_WORKERS_AI).map(([key, info]) => ({
        key,
        model: info.model,
        context: info.context,
        functionCalling: info.functionCalling,
        notes: info.notes,
        assignedToTasks: assignedModels.get(info.model) ?? [],
      }))

      return text({
        available,
        totalCataloged: available.length,
        totalAssignedTasks: Object.keys(MODELS).length,
        directoryUrl: 'https://developers.cloudflare.com/workers-ai/models/',
      })
    },
  )

  // ─── 11. admin_tool_executions ────────────────────────────────────

  server.tool(
    'admin_tool_executions',
    'Recent tool execution log from the hook pipeline. Shows which MCP tools were called, when, how long they took, and whether they succeeded. Use to monitor tool usage patterns and diagnose failures.',
    {
      toolName: z.string().optional().describe('Filter by tool name (e.g. "grimoire_search")'),
      status: z.enum(['success', 'error']).optional().describe('Filter by execution status'),
      limit: z.number().min(1).max(100).default(20).describe('Max results'),
    },
    async ({ toolName, status, limit }) => {
      const conditions: string[] = []
      const binds: (string | number)[] = []

      if (toolName) {
        conditions.push('tool_name = ?')
        binds.push(toolName as string)
      }
      if (status) {
        conditions.push('status = ?')
        binds.push(status as string)
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
      const stmt = env.HOBBOT_DB.prepare(
        `SELECT * FROM tool_executions ${where} ORDER BY created_at DESC LIMIT ?`
      ).bind(...binds, limit as number)

      const result = await stmt.all()
      return text({ executions: result.results, count: result.results.length })
    },
  )

  // ─── 12. admin_token_usage ────────────────────────────────────────

  server.tool(
    'admin_token_usage',
    'AI token usage and estimated cost summary. Shows input/output token counts grouped by model, task type, or worker over a configurable time window. Data comes from token_usage table in HOBBOT_DB, populated by callWithJsonParse onUsage callbacks in pipeline, custodian, and classifier workers.',
    {
      groupBy: z.enum(['model', 'tool', 'worker']).default('model').describe('Group results by model string, task type, or worker name'),
      days: z.number().min(1).max(90).default(7).describe('Look-back window in days'),
      toolName: z.string().optional().describe('Filter to specific task type (e.g. "pipeline.enrichment")'),
      model: z.string().optional().describe('Filter to specific model string'),
    },
    async ({ groupBy, days, toolName, model }) => {
      const groupCol = groupBy === 'tool' ? 'tool_name' : groupBy === 'worker' ? 'worker' : 'model'
      const conditions: string[] = [`created_at > datetime('now', '-${days} days')`]
      const binds: string[] = []

      if (toolName) {
        conditions.push('tool_name = ?')
        binds.push(toolName as string)
      }
      if (model) {
        conditions.push('model = ?')
        binds.push(model as string)
      }

      const where = conditions.join(' AND ')
      const stmt = env.HOBBOT_DB.prepare(
        `SELECT ${groupCol} as group_key,
                SUM(input_tokens) as total_input,
                SUM(output_tokens) as total_output,
                SUM(total_tokens) as total_tokens,
                SUM(estimated_cost_usd) as estimated_cost,
                COUNT(*) as calls
         FROM token_usage
         WHERE ${where}
         GROUP BY group_key
         ORDER BY total_tokens DESC`
      ).bind(...binds)

      const result = await stmt.all()
      const groups = result.results as Record<string, unknown>[]

      const totals = {
        totalTokens: groups.reduce((s, g) => s + ((g.total_tokens as number) ?? 0), 0),
        estimatedCost: groups.reduce((s, g) => s + ((g.estimated_cost as number) ?? 0), 0),
        calls: groups.reduce((s, g) => s + ((g.calls as number) ?? 0), 0),
      }

      return text({ groupBy, days, groups, totals })
    },
  )

  // ─── 13. admin_ingestion_progress ─────────────────────────────────

  server.tool(
    'admin_ingestion_progress',
    'Check status of bulk ingestion batches and overall pipeline health. Shows batch progress, item-level status, and pending pipeline work.',
    {
      batchId: z.string().optional().describe('Specific batch ID to check'),
      showRecent: z.boolean().optional().default(false).describe('Show last 5 batches'),
    },
    async ({ batchId, showRecent }) => {
      if (batchId) {
        const batch = await env.HOBBOT_DB.prepare(
          'SELECT * FROM ingestion_batches WHERE id = ?'
        ).bind(batchId as string).first()

        if (!batch) return text({ error: 'batch not found', batchId })

        const items = await env.HOBBOT_DB.prepare(
          'SELECT url, status, document_id, error, completed_at FROM ingestion_batch_items WHERE batch_id = ? ORDER BY id ASC'
        ).bind(batchId as string).all()

        return text({ batch, items: items.results })
      }

      // Recent batches + pipeline health
      const recentBatches = await env.HOBBOT_DB.prepare(
        'SELECT * FROM ingestion_batches ORDER BY created_at DESC LIMIT 5'
      ).all()

      // Pipeline health counters
      const unenriched = await env.GRIMOIRE_DB.prepare(
        `SELECT count(*) as cnt FROM document_chunks c JOIN documents d ON c.document_id = d.id WHERE c.summary IS NULL AND d.status IN ('chunked', 'enriched')`
      ).first<{ cnt: number }>()

      const pendingEmbeddings = await env.GRIMOIRE_DB.prepare(
        `SELECT count(*) as cnt FROM atoms WHERE embedding_status = 'pending' AND category_slug IS NOT NULL`
      ).first<{ cnt: number }>()

      const pendingClassification = await env.GRIMOIRE_DB.prepare(
        `SELECT count(*) as cnt FROM atoms WHERE category_slug IS NULL OR category_slug = ''`
      ).first<{ cnt: number }>()

      return text({
        recentBatches: recentBatches.results,
        pipeline: {
          unenrichedChunks: unenriched?.cnt ?? 0,
          pendingEmbeddings: pendingEmbeddings?.cnt ?? 0,
          pendingClassification: pendingClassification?.cnt ?? 0,
        },
      })
    },
  )

  // ─── 14. admin_recent_atoms ───────────────────────────────────────

  server.tool(
    'admin_recent_atoms',
    'Show recently created atoms. Useful for monitoring pipeline output, verifying ingestion results, and feeding content decisions.',
    {
      limit: z.number().min(1).max(50).default(10).describe('Max atoms to return'),
      since: z.string().optional().describe('ISO date cutoff (default: last 24h)'),
      category: z.string().optional().describe('Filter by category slug'),
    },
    async ({ limit, since, category }) => {
      const cutoff = since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const conditions = ['created_at >= ?']
      const binds: (string | number)[] = [cutoff]

      if (category) {
        conditions.push('category_slug = ?')
        binds.push(category as string)
      }

      const where = conditions.join(' AND ')
      const atoms = await env.GRIMOIRE_DB.prepare(
        `SELECT id, text, category_slug, collection_slug, status, embedding_status, created_at
         FROM atoms WHERE ${where} ORDER BY created_at DESC LIMIT ?`
      ).bind(...binds, limit as number).all()

      return text({ atoms: atoms.results, count: atoms.results.length, since: cutoff })
    },
  )

  // ─── 15. admin_archive_search ─────────────────────────────────────

  server.tool(
    'admin_archive_search',
    'Search Archive.org collections by metadata, subject, creator, or full-text content. Returns item identifiers with metadata for evaluation before ingestion. The q parameter supports Lucene syntax: quoted phrases, AND/OR/NOT, field-specific queries like subject:(...) or text:(...) for full-text search.',
    {
      query: z.string().describe('Lucene search query. Supports field syntax e.g. text:(game mechanics)'),
      collection: z.string().optional().describe("Limit to a collection e.g. 'gamemanuals', 'manuals_atari'"),
      mediatype: z.string().optional().describe("Mediatype filter, default 'texts'"),
      language: z.string().optional().describe("e.g. 'English'"),
      sort: z.string().optional().describe("Default 'downloads desc'. Options: 'date desc', 'date asc', 'titleSorter asc'. Pass empty string for relevance sort (faster on large collections)."),
      limit: z.number().min(1).max(50).optional().describe('Default 10, max 50'),
    },
    async ({ query, collection, mediatype, language, sort, limit }) => {
      const requestedSort = sort === undefined ? 'downloads desc' : sort
      const baseParams = {
        query,
        collection,
        mediatype: mediatype ?? 'texts',
        language,
        limit: limit ?? 10,
      }

      const runSearch = async (sortValue: string | undefined) => {
        const { hits, totalResults } = await searchItems({ ...baseParams, sort: sortValue })
        return {
          results: hits.map(h => ({
            identifier: h.identifier,
            title: h.title,
            description: h.description,
            creator: h.creator,
            date: h.date,
            downloads: h.downloads,
            collection: h.collection,
            language: h.language,
            detailsUrl: `https://archive.org/details/${h.identifier}`,
            downloadUrl: `https://archive.org/download/${h.identifier}`,
          })),
          totalResults,
        }
      }

      try {
        const r = await runSearch(requestedSort || undefined)
        return text({ results: r.results, count: r.results.length, totalResults: r.totalResults })
      } catch (e) {
        if (e instanceof IATimeoutError && requestedSort) {
          // Retry once with relevance sort (much faster on large collections)
          try {
            const r = await runSearch(undefined)
            return text({
              results: r.results,
              count: r.results.length,
              totalResults: r.totalResults,
              note: `Sorted by relevance (${requestedSort} sort timed out after 15s).`,
            })
          } catch (e2) {
            if (e2 instanceof IATimeoutError) {
              return text({ error: 'Archive.org request timed out after 15s. Try a narrower query or smaller collection.' })
            }
            return text({ error: (e2 as Error).message })
          }
        }
        if (e instanceof IATimeoutError) {
          return text({ error: 'Archive.org request timed out after 15s. Try a narrower query or smaller collection.' })
        }
        return text({ error: (e as Error).message })
      }
    },
  )

  // ─── 16. admin_archive_item ───────────────────────────────────────

  server.tool(
    'admin_archive_item',
    'Get full metadata, file listing, and view counts for a specific Archive.org item. Use after admin_archive_search to evaluate whether an item is worth ingesting. Files filtered to useful formats (PDF, Text PDF, DjVuTXT, EPUB).',
    {
      identifier: z.string().describe('Archive.org item identifier'),
    },
    async ({ identifier }) => {
      try {
        const [meta, views] = await Promise.all([
          getItemMetadata(identifier),
          getItemViews(identifier),
        ])
        const useful = meta.files.filter(f => {
          const fmt = (f.format ?? '').toLowerCase()
          const name = f.name.toLowerCase()
          return fmt.includes('pdf') || fmt.includes('djvutxt') || fmt.includes('epub') ||
                 name.endsWith('.pdf') || name.endsWith('.epub') || name.endsWith('_djvu.txt')
        }).map(f => ({
          name: f.name,
          format: f.format,
          size: f.size,
          downloadUrl: buildDownloadUrl(identifier, f.name),
        }))
        return text({
          identifier: meta.identifier,
          title: meta.title,
          description: meta.description,
          creator: meta.creator,
          date: meta.date,
          subject: meta.subject,
          collections: meta.collections,
          language: meta.language,
          ocrEngine: meta.ocrEngine,
          ocrAvailable: meta.ocrAvailable,
          files: useful,
          views: views ?? null,
        })
      } catch (e) {
        return text({ error: (e as Error).message, identifier })
      }
    },
  )

  // ─── 17. admin_archive_preview ────────────────────────────────────

  server.tool(
    'admin_archive_preview',
    'Preview the OCR text content of an Archive.org item without full ingestion. Fetches the DjVuTXT file (or _ocr_search.txt fallback) so you can read the first few thousand characters before deciding to ingest. If no OCR text exists, reports that clearly.',
    {
      identifier: z.string().describe('Archive.org item identifier'),
      maxChars: z.number().min(1).max(10000).optional().describe('Default 3000, max 10000'),
    },
    async ({ identifier, maxChars }) => {
      try {
        const preview = await fetchTextPreview(identifier, maxChars ?? 3000)
        if (preview.source === null) {
          return text({
            identifier,
            preview: null,
            note: 'No OCR text available (no _djvu.txt or _ocr_search.txt). PDF-only item; ingestion will require PDF text extraction.',
          })
        }
        return text({
          identifier,
          preview: preview.text,
          previewLength: preview.text.length,
          totalLength: preview.totalLength,
          ocrQuality: preview.ocrQuality,
          source: preview.source,
        })
      } catch (e) {
        return text({ error: (e as Error).message, identifier })
      }
    },
  )
}
