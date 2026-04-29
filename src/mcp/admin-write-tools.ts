// Write-capable admin MCP tools: trigger operations, purge stale data, reindex.
// Phase 4A of hobbot-enhancement-plan.md.
//
// Safety model: every write tool requires `confirm: true` to execute.
// Without it, the tool returns a preview of what it would do.
// Two-step pattern: call without confirm to see the plan, call with confirm to execute.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { Env } from '../index'
import { getItemMetadata, pickBestPdf } from '../clients/archive-org'

function text(data: unknown) {
  return { content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] }
}

/** Resolve SERVICE_TOKENS from Secrets Store binding, extract first token's secret. */
async function resolveServiceSecret(env: Env): Promise<string> {
  const raw = env.SERVICE_TOKENS as unknown
  const tokenList = (raw && typeof raw === 'object' && 'get' in raw && typeof (raw as { get: unknown }).get === 'function')
    ? await (raw as { get: () => Promise<string> }).get() ?? ''
    : (raw as string) ?? ''
  const firstPair = tokenList.split(',')[0]?.trim() ?? ''
  const colonIdx = firstPair.indexOf(':')
  return colonIdx >= 1 ? firstPair.slice(colonIdx + 1).trim() : firstPair
}

export function registerAdminWriteTools(server: McpServer, env: Env) {

  // ─── 1. admin_trigger_enrichment ──────────────────────────────────

  server.tool(
    'admin_trigger_enrichment',
    'Trigger a pipeline enrichment batch. Processes pending document chunks through AI extraction. Async: returns immediately, enrichment runs in background. Check admin_cron_status or admin_d1_query for results.',
    {
      confirm: z.boolean().optional().default(false).describe('Set true to execute. False or absent returns a preview.'),
    },
    async ({ confirm }) => {
      const pending = await env.GRIMOIRE_DB.prepare(`
        SELECT count(*) as cnt FROM document_chunks c
        JOIN documents d ON c.document_id = d.id
        WHERE c.summary IS NULL AND d.status IN ('chunked', 'enriched')
      `).first<{ cnt: number }>()

      if (!confirm) {
        return text({
          action: 'preview',
          description: 'Would trigger enrichment batch (10 chunks per invocation, self-chaining)',
          pendingChunks: pending?.cnt ?? 0,
          estimatedDuration: '30-60 seconds per batch of 10',
        })
      }

      if ((pending?.cnt ?? 0) === 0) {
        return text({ action: 'skipped', reason: 'No pending chunks to enrich' })
      }

      await (env.HOBBOT_PIPELINE as unknown as Fetcher).fetch(
        'https://hobbot-pipeline/internal/enrich-trigger',
        { method: 'POST' },
      )

      return text({
        action: 'executed',
        mode: 'async',
        pendingChunks: pending?.cnt ?? 0,
        message: 'Enrichment triggered. Check admin_cron_status or admin_d1_query for results.',
      })
    },
  )

  // ─── 2. admin_trigger_conductor ───────────────────────────────────

  server.tool(
    'admin_trigger_conductor',
    'Run the custodian conductor to analyze Grimoire gaps and generate knowledge acquisition requests. Creates knowledge_request entries for the archive-org agent to claim. Returns synchronous results.',
    {
      confirm: z.boolean().optional().default(false).describe('Set true to execute. False or absent returns a preview.'),
    },
    async ({ confirm }) => {
      const pendingRequests = await env.HOBBOT_DB.prepare(
        `SELECT count(*) as cnt FROM knowledge_requests WHERE status = 'pending'`
      ).first<{ cnt: number }>()

      let lastRun: Record<string, unknown> | null = null
      if (env.PROVIDER_HEALTH) {
        const raw = await env.PROVIDER_HEALTH.get('cron:last:hobbot-custodian:conductor')
        if (raw) try { lastRun = JSON.parse(raw) } catch { /* skip */ }
      }

      if (!confirm) {
        return text({
          action: 'preview',
          description: 'Would run conductor gap analysis (involves AI calls, takes 10-30s)',
          currentPendingRequests: pendingRequests?.cnt ?? 0,
          lastRun,
        })
      }

      const custodian = env.HOBBOT_CUSTODIAN as unknown as { runConductor(): Promise<unknown> }
      const result = await custodian.runConductor()

      return text({ action: 'executed', result })
    },
  )

  // ─── 3. admin_trigger_rss ─────────────────────────────────────────

  server.tool(
    'admin_trigger_rss',
    'Trigger immediate RSS harvest and feed processing. Runs the custodian RSS harvester, then triggers pipeline to ingest any new entries. Returns synchronous harvest results.',
    {
      confirm: z.boolean().optional().default(false).describe('Set true to execute. False or absent returns a preview.'),
    },
    async ({ confirm }) => {
      const pendingEntries = await env.HOBBOT_DB.prepare(
        `SELECT count(*) as cnt FROM feed_entries WHERE ingested = 0`
      ).first<{ cnt: number }>()

      let lastRun: Record<string, unknown> | null = null
      if (env.PROVIDER_HEALTH) {
        const raw = await env.PROVIDER_HEALTH.get('cron:last:hobbot-custodian:rss')
        if (raw) try { lastRun = JSON.parse(raw) } catch { /* skip */ }
      }

      if (!confirm) {
        return text({
          action: 'preview',
          description: 'Would harvest RSS feeds and trigger pipeline ingest',
          pendingEntries: pendingEntries?.cnt ?? 0,
          lastRun,
        })
      }

      const custodian = env.HOBBOT_CUSTODIAN as unknown as { harvest(s: string, n: number): Promise<{ items_fetched: number; items_ingested: number; items_skipped: number }> }
      const harvest = await custodian.harvest('rss-feeds', 50)

      let pipelineTriggered = false
      if (harvest.items_ingested > 0) {
        try {
          await (env.HOBBOT_PIPELINE as unknown as Fetcher).fetch(
            'https://hobbot-pipeline/internal/rss-ingest',
            { method: 'POST' },
          )
          pipelineTriggered = true
        } catch {
          // Non-fatal: pipeline cron will pick them up
        }
      }

      return text({ action: 'executed', harvest, pipelineTriggered })
    },
  )

  // ─── 4. admin_purge_stale ─────────────────────────────────────────

  server.tool(
    'admin_purge_stale',
    'Clean up stale records across HobBot databases. Targets: tool_executions (HOBBOT_DB, 30-day default), discovery_queue (GRIMOIRE_DB, only resolved entries, never active/pending), failed_operations (GRIMOIRE_DB). Minimum retention is 7 days.',
    {
      target: z.enum(['tool_executions', 'discovery_queue', 'failed_operations', 'all']).default('all').describe('Which data to purge'),
      olderThanDays: z.number().min(7).default(30).describe('Delete records older than this many days (minimum 7)'),
      confirm: z.boolean().optional().default(false).describe('Set true to execute. False or absent returns a preview.'),
    },
    async ({ target, olderThanDays, confirm }) => {
      const days = Math.max(7, olderThanDays)
      const targets = target === 'all' ? ['tool_executions', 'discovery_queue', 'failed_operations'] : [target]

      const queries: Record<string, { db: D1Database; countSql: string; deleteSql: string }> = {
        tool_executions: {
          db: env.HOBBOT_DB,
          countSql: `SELECT count(*) as cnt FROM tool_executions WHERE created_at < datetime('now', '-${days} days')`,
          deleteSql: `DELETE FROM tool_executions WHERE created_at < datetime('now', '-${days} days')`,
        },
        discovery_queue: {
          db: env.GRIMOIRE_DB,
          countSql: `SELECT count(*) as cnt FROM discovery_queue WHERE resolved_at IS NOT NULL AND created_at < datetime('now', '-${days} days')`,
          deleteSql: `DELETE FROM discovery_queue WHERE resolved_at IS NOT NULL AND created_at < datetime('now', '-${days} days')`,
        },
        failed_operations: {
          db: env.GRIMOIRE_DB,
          countSql: `SELECT count(*) as cnt FROM failed_operations WHERE failed_at < datetime('now', '-${days} days')`,
          deleteSql: `DELETE FROM failed_operations WHERE failed_at < datetime('now', '-${days} days')`,
        },
      }

      if (!confirm) {
        const counts: Record<string, number> = {}
        let total = 0
        for (const t of targets) {
          const q = queries[t]
          if (!q) continue
          const row = await q.db.prepare(q.countSql).first<{ cnt: number }>()
          counts[t] = row?.cnt ?? 0
          total += counts[t]
        }
        return text({ action: 'preview', targets, olderThanDays: days, counts, totalToDelete: total })
      }

      const deleted: Record<string, number | string> = {}
      let total = 0
      for (const t of targets) {
        const q = queries[t]
        if (!q) continue
        try {
          const result = await q.db.prepare(q.deleteSql).run()
          const count = result.meta.changes ?? 0
          deleted[t] = count
          total += count
        } catch (e) {
          deleted[t] = `error: ${e instanceof Error ? e.message : String(e)}`
        }
      }

      return text({ action: 'executed', olderThanDays: days, deleted, totalDeleted: total })
    },
  )

  // ─── 5. admin_grimoire_reindex ────────────────────────────────────

  server.tool(
    'admin_grimoire_reindex',
    'Trigger re-vectorization for atoms missing embeddings. Enqueues atoms with embedding_status=pending to the Grimoire vectorization queue. Use after bulk imports or when atoms are not appearing in semantic search.',
    {
      limit: z.number().min(1).max(500).default(100).describe('Max atoms to enqueue (default 100, max 500)'),
      confirm: z.boolean().optional().default(false).describe('Set true to execute. False or absent returns a preview.'),
    },
    async ({ limit, confirm }) => {
      const pending = await env.GRIMOIRE_DB.prepare(
        `SELECT count(*) as cnt FROM atoms WHERE embedding_status = 'pending' AND category_slug IS NOT NULL`
      ).first<{ cnt: number }>()

      if (!confirm) {
        return text({
          action: 'preview',
          description: 'Would enqueue atoms for re-vectorization via grimoire worker',
          atomsMissingEmbeddings: pending?.cnt ?? 0,
          wouldEnqueue: Math.min(limit, pending?.cnt ?? 0),
        })
      }

      if ((pending?.cnt ?? 0) === 0) {
        return text({ action: 'skipped', reason: 'No atoms with pending embedding status' })
      }

      const secret = await resolveServiceSecret(env)
      const response = await env.GRIMOIRE.fetch('https://grimoire/admin/vectorize-batch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${secret}`,
        },
        body: JSON.stringify({ limit }),
      })

      if (!response.ok) {
        const errText = await response.text().catch(() => 'unknown')
        return text({ action: 'error', status: response.status, error: errText.slice(0, 500) })
      }

      const result = await response.json()
      return text({ action: 'executed', result })
    },
  )

  // ─── 6. admin_bulk_ingest ─────────────────────────────────────────

  server.tool(
    'admin_bulk_ingest',
    'Queue multiple URLs for knowledge ingestion as a named batch. Each URL is processed through the full pipeline (fetch, chunk, enrich, match, index, relate). Max 20 URLs per batch. Returns a batch ID for tracking via admin_ingestion_progress.',
    {
      urls: z.array(z.object({
        url: z.string().describe('URL to ingest'),
        source_type: z.enum(['aesthetic', 'domain']).default('domain').describe('Content type'),
        tags: z.array(z.string()).optional().describe('Tags for this URL'),
      })).max(20).describe('URLs to ingest (max 20)'),
      batchName: z.string().optional().describe('Batch name for tracking (e.g. "cartography-vol-1")'),
      collection_slug: z.string().default('uncategorized').describe('Collection for extracted atoms'),
      confirm: z.boolean().optional().default(false).describe('Set true to execute. False or absent returns a preview.'),
    },
    async ({ urls, batchName, collection_slug, confirm }) => {
      if (!confirm) {
        return text({
          action: 'preview',
          urlCount: urls.length,
          batchName: batchName ?? '(auto-generated)',
          collection_slug,
          estimatedDuration: `${urls.length * 2}-${urls.length * 5} minutes total`,
          urls: (urls as { url: string }[]).map(u => u.url),
        })
      }

      const batchId = batchName
        ? `batch-${new Date().toISOString().slice(0, 10)}-${batchName}`
        : `batch-${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`
      const now = new Date().toISOString()

      // Create batch record
      await env.HOBBOT_DB.prepare(
        `INSERT INTO ingestion_batches (id, name, total_urls, created_at) VALUES (?, ?, ?, ?)`
      ).bind(batchId, batchName ?? null, urls.length, now).run()

      // Create batch items and fire off async ingestion for each
      const pipelineFetcher = env.HOBBOT_PIPELINE as unknown as Fetcher

      for (const item of urls as { url: string; source_type?: string; tags?: string[] }[]) {
        await env.HOBBOT_DB.prepare(
          `INSERT INTO ingestion_batch_items (batch_id, url, source_type, created_at) VALUES (?, ?, ?, ?)`
        ).bind(batchId, item.url, item.source_type ?? 'domain', now).run()

        // Fire-and-forget: pipeline processes in background via ctx.waitUntil
        // Batch item status updated by the pipeline's /internal/ingest-async handler
        pipelineFetcher.fetch('https://hobbot-pipeline/internal/ingest-async', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: item.url,
            source_type: item.source_type ?? 'domain',
            collection_slug,
            batch_id: batchId,
          }),
        }).catch(e => console.error(`[bulk-ingest] failed to trigger ${item.url}: ${e}`))
      }

      return text({
        action: 'executed',
        batchId,
        total: urls.length,
        message: `${urls.length} URLs queued for async ingestion. Track progress via admin_ingestion_progress with batchId "${batchId}".`,
      })
    },
  )

  // ─── 7. admin_archive_ingest ──────────────────────────────────────

  server.tool(
    'admin_archive_ingest',
    'Ingest a specific Archive.org item into the Grimoire. Resolves the best PDF (prefers Text PDF with embedded OCR), then fires the async ingestion pipeline. Two-step: call without confirm to preview the resolved PDF, then call with confirm:true to execute. Track progress via admin_ingestion_progress.',
    {
      identifier: z.string().describe('Archive.org item identifier'),
      collection: z.string().optional().describe('Target Grimoire collection slug'),
      sourceType: z.enum(['domain', 'aesthetic']).optional().describe("Default 'domain'"),
      tags: z.array(z.string()).optional().describe('Tags for the ingested document'),
      confirm: z.boolean().optional().default(false).describe('Set true to execute. False or absent returns a preview.'),
    },
    async ({ identifier, collection, sourceType, tags, confirm }) => {
      let meta
      try {
        meta = await getItemMetadata(identifier)
      } catch (e) {
        return text({ error: (e as Error).message, identifier })
      }
      const pdf = pickBestPdf(meta.files)
      if (!pdf) {
        return text({ action: 'error', identifier, error: 'No PDF or EPUB file found in item' })
      }
      const downloadUrl = pdf.downloadUrl(identifier)
      const targetCollection = collection ?? 'uncategorized'
      const source_type = sourceType ?? 'domain'

      if (!confirm) {
        return text({
          action: 'preview',
          identifier,
          title: meta.title,
          pdfFile: pdf.filename,
          pdfFormat: pdf.format,
          pdfSize: pdf.size,
          pdfSizeMB: Math.round(pdf.sizeMB * 10) / 10,
          downloadUrl,
          targetCollection,
          sourceType: source_type,
          ocrAvailable: meta.ocrAvailable,
        })
      }

      try {
        await (env.HOBBOT_PIPELINE as unknown as Fetcher).fetch(
          'https://hobbot-pipeline/internal/ingest-async',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url: downloadUrl,
              source_type,
              collection_slug: targetCollection,
              tags: tags ?? [],
            }),
          },
        )
      } catch (e) {
        return text({ action: 'error', error: (e as Error).message, identifier, url: downloadUrl })
      }

      return text({
        action: 'executed',
        status: 'accepted',
        identifier,
        url: downloadUrl,
        targetCollection,
        message: 'Ingestion started. Check admin_ingestion_progress for status.',
      })
    },
  )

  // ─── 8. admin_bulk_summarize ──────────────────────────────────────

  server.tool(
    'admin_bulk_summarize',
    'Trigger BulkSummarizeWorkflow on the grimoire worker to backfill chunk summaries (summary IS NULL AND embedding_status = complete). dryRun:true (default) returns the count of unsummarized chunks without triggering the workflow. dryRun:false launches the workflow and returns the instance ID; track via admin_d1_query against the workflow status.',
    {
      maxChunks: z.number().int().min(1).optional().describe('Cap on total chunks processed (omit for unbounded)'),
      batchSize: z.number().int().min(1).max(50).optional().describe('Chunks per workflow step (default 10)'),
      dryRun: z.boolean().optional().default(true).describe('true (default) returns preview count; false triggers the workflow'),
    },
    async ({ maxChunks, batchSize, dryRun }) => {
      if (dryRun !== false) {
        const row = await env.GRIMOIRE_DB.prepare(
          "SELECT COUNT(*) AS cnt FROM document_chunks WHERE summary IS NULL AND embedding_status = 'complete' AND content IS NOT NULL AND LENGTH(content) > 0"
        ).first<{ cnt: number }>()
        const unsummarized = row?.cnt ?? 0
        return text({
          action: 'preview',
          unsummarized_chunks: unsummarized,
          would_process: typeof maxChunks === 'number' ? Math.min(unsummarized, maxChunks) : unsummarized,
          batchSize: batchSize ?? 10,
          maxChunks: maxChunks ?? null,
        })
      }

      const secret = await resolveServiceSecret(env)
      const response = await env.GRIMOIRE.fetch('https://grimoire/admin/bulk-summarize', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${secret}`,
        },
        body: JSON.stringify({
          ...(typeof maxChunks === 'number' ? { maxChunks } : {}),
          ...(typeof batchSize === 'number' ? { batchSize } : {}),
          dryRun: false,
        }),
      })

      if (!response.ok) {
        const errText = await response.text().catch(() => 'unknown')
        return text({ action: 'error', status: response.status, error: errText.slice(0, 500) })
      }

      const result = await response.json()
      return text({ action: 'executed', result })
    },
  )

  // ─── 9. admin_bulk_image_candidates ───────────────────────────────

  server.tool(
    'admin_bulk_image_candidates',
    'Bulk-review image extraction candidates by confidence threshold on the grimoire worker. Approves atom candidates with confidence >= atom_min_confidence and rejects correspondence candidates with suggested_strength <= corr_max_strength. At least one of atom_min_confidence or corr_max_strength is required. dry_run:true (default) returns match counts without writing; dry_run:false executes approvals/rejections.',
    {
      atom_min_confidence: z.number().min(0).max(1).optional().describe('Approve atom candidates with confidence >= this. Omit to skip atoms.'),
      atom_max_to_approve: z.number().int().min(1).optional().describe('Safety cap on atoms to approve (default 10000)'),
      corr_max_strength: z.number().min(0).max(1).optional().describe('Reject correspondence candidates with suggested_strength <= this. Omit to skip correspondences.'),
      corr_max_to_reject: z.number().int().min(1).optional().describe('Safety cap on correspondences to reject (default 10000)'),
      dry_run: z.boolean().optional().default(true).describe('true (default) returns match counts; false executes the approvals/rejections'),
    },
    async ({ atom_min_confidence, atom_max_to_approve, corr_max_strength, corr_max_to_reject, dry_run }) => {
      if (atom_min_confidence === undefined && corr_max_strength === undefined) {
        return text({ action: 'error', error: 'At least one of atom_min_confidence or corr_max_strength is required' })
      }

      const body: Record<string, unknown> = { dry_run: dry_run !== false }
      if (typeof atom_min_confidence === 'number') body.atom_min_confidence = atom_min_confidence
      if (typeof atom_max_to_approve === 'number') body.atom_max_to_approve = atom_max_to_approve
      if (typeof corr_max_strength === 'number') body.corr_max_strength = corr_max_strength
      if (typeof corr_max_to_reject === 'number') body.corr_max_to_reject = corr_max_to_reject

      // /image/* on the grimoire worker is not behind serviceTokenAuth, so no Bearer header needed.
      const response = await env.GRIMOIRE.fetch('https://grimoire/image/candidates/bulk-by-confidence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        const errText = await response.text().catch(() => 'unknown')
        return text({ action: 'error', status: response.status, error: errText.slice(0, 500) })
      }

      const result = await response.json()
      return text({ action: dry_run !== false ? 'preview' : 'executed', result })
    },
  )

  // ─── 10. admin_trigger_phase ──────────────────────────────────────

  server.tool(
    'admin_trigger_phase',
    'Run a single grimoire cron phase synchronously and return the result. Cuts the 15-minute feedback loop after a deploy. Phases: phase_1_classify, phase_2_vectorize, phase_2b_vectorize_chunks (alias phase_2b_embed), phase_3_harmonics, phase_4_tagging, phase_5_register, phase_6_correspondences (alias phase_6_discover), phase_8_connectivity. dry_run:true returns what the phase would process without queue sends, D1 writes, or LLM calls.',
    {
      phase: z.string().describe('Phase name (see tool description for valid values)'),
      dry_run: z.boolean().optional().default(true).describe('true (default) returns preview; false runs the phase'),
      batch_size_override: z.number().int().min(1).max(200).optional().describe('Override batch size (phase_8_connectivity only; default 50)'),
    },
    async ({ phase, dry_run, batch_size_override }) => {
      const body: Record<string, unknown> = { dry_run: dry_run !== false }
      if (typeof batch_size_override === 'number') body.batch_size_override = batch_size_override

      const secret = await resolveServiceSecret(env)
      const response = await env.GRIMOIRE.fetch(`https://grimoire/admin/trigger-phase/${encodeURIComponent(phase)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${secret}`,
        },
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        const errText = await response.text().catch(() => 'unknown')
        return text({ action: 'error', status: response.status, error: errText.slice(0, 500) })
      }

      const result = await response.json()
      return text({ action: dry_run !== false ? 'preview' : 'executed', result })
    },
  )
}
