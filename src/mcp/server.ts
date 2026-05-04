// MCP server factory: exposes GrimoireHandle methods as MCP tools
// New McpServer instance per request (SDK 1.26.0 security requirement)
// Shared tools (MCP+chat overlap) registered from manifests.
// MCP-only tools registered directly below.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { createGrimoireHandle } from '../grimoire/handle'
import { ingestAtom } from '../grimoire/ingest'
import { registerAdminTools } from './admin-tools'
import { registerAdminWriteTools } from './admin-write-tools'
import { GRIMOIRE_MANIFESTS, registerMcpTool } from '../tools'
import type { Env } from '../index'

type McpResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

function text(data: unknown): McpResult {
  return { content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] }
}

function errText(data: unknown): McpResult {
  return { ...text(data), isError: true }
}

export function createGrimoireMcpServer(env: Env): McpServer {
  const server = new McpServer({ name: 'Grimoire', version: '1.0.0' })
  const handle = createGrimoireHandle(env.GRIMOIRE_DB)

  // ─── Manifest-driven tools (shared with chat surface) ─────────────
  // Definitions from src/tools/manifests/grimoire.ts.
  // Handlers provided here because they need runtime env bindings.

  const mcpHandlers: Record<string, (params: Record<string, unknown>) => Promise<McpResult>> = {
    grimoire_search: async ({ q, category, collection, limit }) => {
      const result = await handle.search(q as string, { category: category as string, collection: collection as string, limit: limit as number })
      return text(result)
    },

    grimoire_lookup: async ({ term }) => {
      const result = await handle.lookup(term as string)
      if (!result) return errText({ error: 'not_found', message: `No atom found for term: ${term}` })
      return text(result)
    },

    grimoire_recommend: async ({ intent, arrangement }) => {
      const result = await handle.recommend(intent as string, arrangement as string | undefined)
      return text(result)
    },

    grimoire_correspondences: async ({ term, depth }) => {
      const result = await handle.correspondences(term as string, (depth as number) ?? 2)
      return text(result)
    },

    grimoire_arrangements: async () => {
      return text(await handle.arrangements())
    },

    grimoire_categories: async () => {
      return text(await handle.categories())
    },

    grimoire_document_search: async ({ query, category, arrangement, document_id, limit }) => {
      const result = await handle.documentChunkSearch(query as string, {
        category: category as string, arrangement: arrangement as string,
        document_id: document_id as string, limit: limit as number,
      })
      return text(result)
    },

    grimoire_stats: async () => {
      return text(await handle.stats())
    },
  }

  for (const manifest of GRIMOIRE_MANIFESTS) {
    if (!manifest.surfaces.includes('mcp')) continue
    const handler = mcpHandlers[manifest.name]
    if (!handler) throw new Error(`No MCP handler for manifest tool: ${manifest.name}`)
    registerMcpTool(manifest, server, handler, env)
  }

  // ─── MCP-only tools (not in chat, registered directly) ────────────

  server.tool(
    'grimoire_collections',
    'List all atom collections',
    {},
    async () => text(await handle.collections()),
  )

  server.tool(
    'grimoire_incantations',
    'List all incantations (structural prompt templates) with their slots',
    {},
    async () => text(await handle.incantations()),
  )

  server.tool(
    'grimoire_incantation',
    'Get a specific incantation by slug with its slot structure',
    { slug: z.string().describe('Incantation slug identifier') },
    async ({ slug }) => {
      const result = await handle.incantation(slug)
      if (!result) return errText({ error: 'not_found', message: `No incantation found for slug: ${slug}` })
      return text(result)
    },
  )

  server.tool(
    'grimoire_exemplars',
    'Get exemplar evidence for a specific atom showing proven usage patterns',
    { atom_id: z.string().describe('Atom ID to get exemplars for') },
    async ({ atom_id }) => text(await handle.exemplarsFor(atom_id)),
  )

  // --- Daily Review ---

  server.tool(
    'grimoire_daily_review',
    'Get the daily Grimoire review report. Shows new atoms, quality gate stats, pipeline health, latency, and strongest new correspondences from the last 24 hours.',
    {
      date: z.string().optional().describe('Date in YYYY-MM-DD format. Defaults to today.'),
    },
    async ({ date }) => {
      try {
        const dateParam = date ? `?date=${date}` : ''
        const response = await env.GRIMOIRE.fetch(`https://grimoire/review/daily${dateParam}`)
        if (!response.ok) {
          const err = await response.text()
          return { content: [{ type: 'text' as const, text: `No review available: ${err}` }] }
        }
        const reviewText = await response.text()
        return { content: [{ type: 'text' as const, text: reviewText }] }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error fetching review: ${e instanceof Error ? e.message : String(e)}` }] }
      }
    },
  )

  // --- Write path ---

  server.tool(
    'grimoire_ingest',
    'Ingest a new atom into the Grimoire. Validates, deduplicates, and sanitizes automatically. Returns the created atom on success or validation errors on failure.',
    {
      text: z.string().describe('The atom text'),
      collection_slug: z.string().describe('Target collection'),
      category_slug: z.string().optional().describe('Category classification'),
      observation: z.enum(['observation', 'interpretation']).default('observation').describe('Observation type'),
      source: z.enum(['seed', 'ai', 'manual']).default('manual').describe('Origin source'),
      modality: z.enum(['visual', 'both']).default('both').describe('Modality type'),
      confidence: z.number().min(0).max(1).default(0.5).describe('Confidence score 0-1'),
      tags: z.array(z.string()).optional().describe('Tags for the atom'),
      source_app: z.string().optional().describe('Attribution, e.g. "claude-desktop", "hobbot"'),
    },
    async (input) => {
      const result = await ingestAtom(env.GRIMOIRE_DB, input)
      if (!result.atom) return errText(result.validation)
      return text(result)
    },
  )

  // --- Knowledge Ingest Pipeline ---

  server.tool(
    'grimoire_ingest_knowledge',
    'Extract and ingest structured knowledge from a URL into the Grimoire. Fetches the page, extracts visual/creative vocabulary via Gemini, and inserts atoms through the classification pipeline. Supports aesthetic (Aesthetics Wiki, art movements) and domain (Wikipedia, reference material) source types. Use dry_run to preview extraction without inserting.',
    {
      url: z.string().url().describe('URL to fetch and extract knowledge from'),
      source_type: z.enum(['aesthetic', 'domain']).default('aesthetic').describe('aesthetic = visual style pages. domain = topic/reference material.'),
      collection_slug: z.string().optional().describe('Target collection for created atoms (default: uncategorized)'),
      dry_run: z.boolean().optional().default(false).describe('If true, extract and preview without inserting atoms'),
    },
    async ({ url, source_type, collection_slug, dry_run }) => {
      if (dry_run) {
        // Dry run still blocks (lightweight, no AI calls)
        try {
          const pipeline = (env as any).HOBBOT_PIPELINE as any
          const result = await pipeline.ingestFromUrl({ url, source_type, collection_slug, dry_run: true })
          return text(result)
        } catch (err) {
          return errText({ error: 'ingest_failed', message: (err as Error).message })
        }
      }

      // Non-dry-run: fire-and-forget via pipeline's async endpoint
      try {
        await (env.HOBBOT_PIPELINE as unknown as Fetcher).fetch(
          'https://hobbot-pipeline/internal/ingest-async',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, source_type, collection_slug }),
          },
        )
        return text({
          status: 'accepted',
          url,
          message: 'Ingestion started. Check admin_ingestion_progress or admin_d1_query for results.',
        })
      } catch (err) {
        return errText({ error: 'ingest_trigger_failed', message: (err as Error).message })
      }
    },
  )

  // --- Knowledge Layer: Documents (Librarian) ---

  server.tool(
    'grimoire_document_add',
    'Register a new document in the Grimoire. Actual files live on R2; this stores metadata and tracks chunking status.',
    {
      title: z.string().describe('Document title'),
      mime_type: z.string().describe('MIME type (text/plain, text/markdown, application/pdf, text/html)'),
      description: z.string().optional().describe('Document description'),
      r2_key: z.string().optional().describe('R2 object key (grimoire/documents/{id}/{filename})'),
      source_url: z.string().optional().describe('Original URL of the document'),
      tags: z.array(z.string()).optional().describe('Tags for the document'),
      token_count: z.number().optional().describe('Token count of the full document'),
      source_app: z.string().optional().describe('Source application'),
    },
    async ({ title, mime_type, description, r2_key, source_url, tags, token_count, source_app }) => {
      const doc = await handle.documentAdd({
        id: crypto.randomUUID(), title, description: description ?? null, mime_type,
        r2_key: r2_key ?? null, source_url: source_url ?? null, tags: tags ?? [],
        token_count: token_count ?? null, chunk_count: 0, status: 'pending', source_app: source_app ?? null,
      })
      return text(doc)
    },
  )

  server.tool(
    'grimoire_document_chunk',
    'Add a chunk of content to a document. CC does the chunking; this stores the result. Call multiple times for multi-chunk documents. Updates document status to "chunking" on first chunk.',
    {
      document_id: z.string().describe('Document ID to add chunk to'),
      chunk_index: z.number().int().min(0).describe('Zero-based index of this chunk'),
      content: z.string().describe('Chunk text content'),
      summary: z.string().optional().describe('Summary of the chunk'),
      token_count: z.number().optional().describe('Token count for this chunk'),
      category_slug: z.string().optional().describe('Category classification for this chunk'),
      arrangement_slugs: z.array(z.string()).optional().describe('Arrangement slugs relevant to this chunk'),
      metadata: z.record(z.string(), z.unknown()).optional().describe('Additional metadata'),
    },
    async ({ document_id, chunk_index, content, summary, token_count, category_slug, arrangement_slugs, metadata }) => {
      if (chunk_index === 0) await handle.documentUpdateStatus(document_id as string, 'chunking')
      const chunk = await handle.documentChunkAdd({
        id: crypto.randomUUID(), document_id: document_id as string, chunk_index: chunk_index as number,
        content: content as string, summary: (summary as string) ?? null, token_count: (token_count as number) ?? null,
        category_slug: (category_slug as string) ?? null, arrangement_slugs: (arrangement_slugs as string[]) ?? [],
        metadata: (metadata as Record<string, unknown>) ?? {},
      })
      return text(chunk)
    },
  )

  server.tool(
    'grimoire_document_finalize',
    'Mark a document as fully chunked. Updates status to "chunked" and sets final chunk_count.',
    {
      document_id: z.string().describe('Document ID to finalize'),
      chunk_count: z.number().int().min(0).describe('Total number of chunks added'),
    },
    async ({ document_id, chunk_count }) => {
      await handle.documentUpdateStatus(document_id, 'chunked', chunk_count)
      const result = await handle.documentGet(document_id)
      if (!result) return errText({ error: 'not_found', message: `No document found: ${document_id}` })
      return text(result.document)
    },
  )

  server.tool(
    'grimoire_document_get',
    "Get a document's metadata and all its chunks.",
    { document_id: z.string().describe('Document ID') },
    async ({ document_id }) => {
      const result = await handle.documentGet(document_id)
      if (!result) return errText({ error: 'not_found', message: `No document found: ${document_id}` })
      return text(result)
    },
  )

  // --- Knowledge Layer: Discovery Queue (Curator) ---

  server.tool(
    'grimoire_discover',
    'Submit a term to the discovery queue for curation. Use instead of direct ingest when the term needs quality review.',
    {
      term: z.string().describe('The proposed atom term'),
      source_app: z.string().describe('Source application (e.g. "stylefusion", "hobbot", "claude-desktop")'),
      ir_slot: z.string().optional().describe('IR slot this term was extracted from'),
      arrangement_slug: z.string().optional().describe('Arrangement context'),
      source_context: z.record(z.string(), z.unknown()).optional().describe('Context from the discovering agent'),
      suggested_category: z.string().optional().describe('Suggested category slug'),
      suggested_collection: z.string().optional().describe('Suggested collection slug'),
    },
    async ({ term, source_app, ir_slot, arrangement_slug, source_context, suggested_category, suggested_collection }) => {
      const entry = await handle.discoverySubmit({
        id: crypto.randomUUID(), term: term as string, ir_slot: (ir_slot as string) ?? null,
        arrangement_slug: (arrangement_slug as string) ?? null, source_app: source_app as string,
        source_context: (source_context as Record<string, unknown>) ?? {},
        suggested_category: (suggested_category as string) ?? null, suggested_collection: (suggested_collection as string) ?? null,
      })
      return text(entry)
    },
  )

  server.tool(
    'grimoire_queue_list',
    'List discovery queue items. Defaults to pending items. Use to review what needs curation.',
    {
      status: z.enum(['pending', 'accepted', 'rejected', 'merged']).optional().default('pending').describe('Filter by status'),
      source_app: z.string().optional().describe('Filter by source application'),
      limit: z.number().min(1).max(200).default(50).describe('Max results'),
    },
    async ({ status, source_app, limit }) => {
      return text(await handle.discoveryList({ status: status as string, source_app: source_app as string, limit: limit as number }))
    },
  )

  server.tool(
    'grimoire_queue_resolve',
    'Resolve a discovery queue item. Accept creates a confirmed atom. Reject discards with a reason. Merge marks as duplicate.',
    {
      id: z.string().describe('Discovery queue entry ID'),
      action: z.enum(['accept', 'reject', 'merge']).describe('Resolution action'),
      note: z.string().optional().describe('Note explaining the resolution'),
      collection_slug: z.string().optional().describe('Target collection (required for accept)'),
      category_slug: z.string().optional().describe('Category classification'),
      observation: z.enum(['observation', 'interpretation']).optional().default('observation').describe('Observation type'),
      confidence: z.number().min(0).max(1).optional().default(0.7).describe('Confidence score'),
      harmonics: z.record(z.string(), z.unknown()).optional().describe('Harmonic data for the atom'),
      duplicate_of_atom_id: z.string().optional().describe('Existing atom ID (required for merge)'),
    },
    async ({ id, action, note, collection_slug, category_slug, observation, confidence, harmonics, duplicate_of_atom_id }) => {
      try {
        const result = await handle.discoveryResolve(id as string, {
          action, note: note as string, collection_slug: collection_slug as string,
          category_slug: category_slug as string, observation,
          confidence: confidence as number, harmonics, duplicate_of_atom_id: duplicate_of_atom_id as string,
        })
        if (action === 'accept' && !(result as any).atom) {
          return errText({ error: 'validation_failed', message: 'Atom failed validation. Entry remains pending.', queue_entry: (result as any).queue_entry, validation: (result as any).validation })
        }
        return text(result)
      } catch (err) {
        return errText({ error: 'resolve_failed', message: (err as Error).message })
      }
    },
  )

  // --- Knowledge Layer: Atom Relations ---

  server.tool(
    'grimoire_get_related_atoms',
    'Get atoms related to a given atom through typed relations (compositional, oppositional, hierarchical, modifies, co_occurs, derives_from).',
    {
      atom_id: z.string().describe('Atom ID to get relations for'),
      relation_type: z.enum(['compositional', 'oppositional', 'hierarchical', 'modifies', 'co_occurs', 'derives_from']).optional().describe('Filter by relation type'),
      direction: z.enum(['outgoing', 'incoming', 'both']).optional().default('both').describe('Relation direction'),
      limit: z.number().min(1).max(100).default(20).describe('Max results to return'),
    },
    async ({ atom_id, relation_type, direction, limit }) => {
      const result = await handle.getRelatedAtoms(atom_id as string, { relation_type: relation_type as string, direction, limit: limit as number })
      return text({ relations: result })
    },
  )

  server.tool(
    'grimoire_add_relation',
    'Add a typed relation between two atoms. If the exact pair+type+context already exists, updates strength/confidence instead.',
    {
      source_atom_id: z.string().describe('Source atom ID'),
      target_atom_id: z.string().describe('Target atom ID'),
      relation_type: z.enum(['compositional', 'oppositional', 'hierarchical', 'modifies', 'co_occurs', 'derives_from']).describe('Type of relation'),
      strength: z.number().min(0).max(1).optional().default(0.5).describe('Relationship strength (0-1)'),
      context: z.string().optional().describe('Arrangement slug or domain where the relation holds'),
      source: z.enum(['curated', 'discovered', 'inferred', 'observed']).optional().default('curated').describe('How the relation was created'),
      confidence: z.number().min(0).max(1).optional().default(0.7).describe('Certainty about this relation (0-1)'),
    },
    async ({ source_atom_id, target_atom_id, relation_type, strength, context, source, confidence }) => {
      try {
        const result = await handle.addRelation({
          source_atom_id: source_atom_id as string, target_atom_id: target_atom_id as string,
          relation_type, strength: strength as number,
          context: (context as string) ?? null, source, confidence: confidence as number,
        })
        return text(result)
      } catch (err) {
        return errText({ error: 'add_relation_failed', message: (err as Error).message })
      }
    },
  )

  // --- Knowledge Layer: Provider Behaviors ---

  server.tool(
    'grimoire_get_provider_behaviors',
    'Get tracked provider behavior observations. Filter by provider, atom, category, render mode, or severity.',
    {
      provider: z.string().optional().describe('Filter by provider name'),
      atom_id: z.string().optional().describe('Filter by specific atom ID'),
      atom_category: z.string().optional().describe('Filter by atom category slug'),
      render_mode: z.string().optional().describe('Filter by render mode'),
      severity: z.enum(['info', 'warning', 'breaking']).optional().describe('Filter by severity level'),
    },
    async ({ provider, atom_id, atom_category, render_mode, severity }) => {
      const result = await handle.getProviderBehaviors({ provider: provider as string, atom_id: atom_id as string, atom_category: atom_category as string, render_mode: render_mode as string, severity: severity as string })
      return text({ behaviors: result })
    },
  )

  server.tool(
    'grimoire_log_provider_behavior',
    'Log a provider behavior observation.',
    {
      provider: z.string().describe('Provider name'),
      atom_id: z.string().optional().describe('Specific atom ID'),
      atom_category: z.string().optional().describe('Atom category'),
      behavior: z.string().describe('Description of the observed behavior'),
      render_mode: z.string().optional().describe('Render mode context'),
      severity: z.enum(['info', 'warning', 'breaking']).optional().default('info').describe('Severity level'),
    },
    async ({ provider, atom_id, atom_category, behavior, render_mode, severity }) => {
      try {
        const result = await handle.logProviderBehavior({
          provider: provider as string, atom_id: (atom_id as string) ?? null, atom_category: (atom_category as string) ?? null,
          behavior: behavior as string, render_mode: (render_mode as string) ?? null, severity,
        })
        return text(result)
      } catch (err) {
        return errText({ error: 'log_behavior_failed', message: (err as Error).message })
      }
    },
  )

  // --- Image Analysis ---

  server.tool(
    'grimoire_classify_image',
    'Classify an image against Grimoire arrangements and aesthetics. Returns ranked matches and extracted visual vocabulary. Does NOT create atoms.',
    {
      image_base64: z.string().optional().describe('Base64-encoded image data'),
      image_url: z.string().optional().describe('Public URL of image to analyze'),
      r2_key: z.string().optional().describe('R2 key (fetched via cdn.hob.farm)'),
      mime_type: z.string().default('image/jpeg').describe('Image MIME type'),
    },
    async ({ image_base64, image_url, r2_key, mime_type }) => {
      if (!image_base64 && !image_url && !r2_key) return errText({ error: 'missing_input', message: 'One of image_base64, image_url, or r2_key is required' })
      try {
        const pipeline = (env as any).HOBBOT_PIPELINE as any
        return text(await pipeline.classifyImage({ image_base64, image_url, r2_key, mime_type }))
      } catch (err) {
        return errText({ error: 'classify_failed', message: (err as Error).message })
      }
    },
  )

  server.tool(
    'grimoire_ingest_image',
    'Analyze image, extract visual atoms, store as Grimoire source with provenance.',
    {
      image_base64: z.string().optional().describe('Base64-encoded image data'),
      image_url: z.string().optional().describe('Public URL of image to analyze'),
      r2_key: z.string().optional().describe('R2 key (fetched via cdn.hob.farm)'),
      mime_type: z.string().default('image/jpeg').describe('Image MIME type'),
      type: z.enum(['moodboard', 'reference', 'generation']).default('reference').describe('Source type'),
      filename: z.string().optional().describe('Original filename'),
      collection_slug: z.string().default('uncategorized').describe('Collection for extracted atoms'),
      dry_run: z.boolean().default(false).describe('Preview extraction without creating atoms'),
    },
    async ({ image_base64, image_url, r2_key, mime_type, type, filename, collection_slug, dry_run }) => {
      if (!image_base64 && !image_url && !r2_key) return errText({ error: 'missing_input', message: 'One of image_base64, image_url, or r2_key is required' })
      try {
        const pipeline = (env as any).HOBBOT_PIPELINE as any
        return text(await pipeline.ingestFromImage({ image_base64, image_url, r2_key, mime_type, filename: filename ?? 'image', collection_slug, dry_run }))
      } catch (err) {
        return errText({ error: 'ingest_failed', message: (err as Error).message })
      }
    },
  )

  // --- Image Extraction (fromImage adapter on grimoire worker) ---

  server.tool(
    'grimoire_extract_from_image',
    'Extract Grimoire atoms and correspondences from an image using vision models. Produces candidates for human review, does NOT auto-create atoms. Use grimoire_review_image_candidates to approve/reject results.',
    {
      image_url: z.string().url().describe('Public URL of image to analyze'),
      attribution: z.string().optional().describe('Artist, title, date, license if known'),
    },
    async ({ image_url, attribution }) => {
      try {
        const response = await (env.GRIMOIRE as unknown as Fetcher).fetch(
          'https://grimoire/image/extract',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image_url, attribution }),
          },
        )
        if (!response.ok) {
          const err = await response.text()
          return errText({ error: 'extraction_failed', status: response.status, message: err.slice(0, 500) })
        }
        return text(await response.json())
      } catch (err) {
        return errText({ error: 'extraction_failed', message: (err as Error).message })
      }
    },
  )

  server.tool(
    'grimoire_review_image_candidates',
    'List, review, batch-review, or bulk-approve image extraction candidates. Modes: (1) list with filters/grouping, (2) single review by ID, (3) batch review multiple IDs, (4) approve all from a source URL.',
    {
      // Single review
      candidate_id: z.number().optional().describe('ID of candidate to review (single review mode)'),
      action: z.enum(['approve', 'reject']).optional().describe('Review action (requires candidate_id)'),
      notes: z.string().optional().describe('Review notes'),
      // Batch review
      batch_actions: z.array(z.object({
        id: z.number(),
        action: z.enum(['approve', 'reject']),
        notes: z.string().optional(),
      })).optional().describe('Batch review: array of {id, action, notes?}. Max 100.'),
      dry_run: z.boolean().optional().describe('Preview batch/approve-source without writing'),
      // Approve source
      approve_source: z.string().optional().describe('Source URL to bulk-approve all pending candidates from'),
      exclude_ids: z.array(z.number()).optional().describe('IDs to exclude from approve-source'),
      // List filters
      status_filter: z.enum(['pending', 'approved', 'rejected', 'merged']).default('pending').describe('Filter by status when listing'),
      limit: z.number().default(50).describe('Max candidates to return'),
      source_url: z.string().optional().describe('Filter by source image URL'),
      candidate_type: z.enum(['atom', 'correspondence']).optional().describe('Filter by candidate type'),
      min_confidence: z.number().optional().describe('Filter atoms with confidence >= threshold'),
      category: z.string().optional().describe('Filter atoms by suggested_category slug'),
      group_by_source: z.boolean().default(false).describe('Group results by source image'),
    },
    async ({ candidate_id, action, notes, batch_actions, dry_run, approve_source, exclude_ids, status_filter, limit, source_url, candidate_type, min_confidence, category, group_by_source }) => {
      try {
        // Mode 1: Batch review
        if (batch_actions && batch_actions.length > 0) {
          const response = await (env.GRIMOIRE as unknown as Fetcher).fetch(
            'https://grimoire/image/candidates/batch-review',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ actions: batch_actions, dry_run }),
            },
          )
          if (!response.ok) {
            const err = await response.text()
            return errText({ error: 'batch_review_failed', status: response.status, message: err.slice(0, 500) })
          }
          return text(await response.json())
        }

        // Mode 2: Approve source
        if (approve_source) {
          const response = await (env.GRIMOIRE as unknown as Fetcher).fetch(
            'https://grimoire/image/candidates/approve-source',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ source_url: approve_source, exclude_ids }),
            },
          )
          if (!response.ok) {
            const err = await response.text()
            return errText({ error: 'approve_source_failed', status: response.status, message: err.slice(0, 500) })
          }
          return text(await response.json())
        }

        // Mode 3: Single review
        if (candidate_id && action) {
          const response = await (env.GRIMOIRE as unknown as Fetcher).fetch(
            `https://grimoire/image/candidates/${candidate_id}/review`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action, notes }),
            },
          )
          if (!response.ok) {
            const err = await response.text()
            return errText({ error: 'review_failed', status: response.status, message: err.slice(0, 500) })
          }
          return text(await response.json())
        }

        // Mode 4: List with filters
        const params = new URLSearchParams({ status: status_filter, limit: String(limit) })
        if (source_url) params.set('source_url', source_url)
        if (candidate_type) params.set('candidate_type', candidate_type)
        if (min_confidence !== undefined) params.set('min_confidence', String(min_confidence))
        if (category) params.set('category', category)
        if (group_by_source) params.set('group_by_source', 'true')

        const response = await (env.GRIMOIRE as unknown as Fetcher).fetch(
          `https://grimoire/image/candidates?${params.toString()}`,
        )
        return text(await response.json())
      } catch (err) {
        return errText({ error: 'review_failed', message: (err as Error).message })
      }
    },
  )

  server.tool(
    'grimoire_batch_extract',
    'Run batch image extraction on R2-stored images. Processes images under the given prefix, skipping any that already have analysis JSON. Call repeatedly until remaining is 0.',
    {
      prefix: z.string().describe('R2 prefix to scan, e.g. "reference/psychedelic/"'),
      chunk_size: z.number().default(10).describe('Number of images to process per batch (max 25)'),
    },
    async ({ prefix, chunk_size }) => {
      try {
        const response = await (env.GRIMOIRE as unknown as Fetcher).fetch(
          'https://grimoire/image/extract/batch',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prefix, limit: chunk_size }),
          },
        )
        if (!response.ok) {
          const err = await response.text()
          return errText({ error: 'batch_extraction_failed', status: response.status, message: err.slice(0, 500) })
        }
        return text(await response.json())
      } catch (err) {
        return errText({ error: 'batch_extraction_failed', message: (err as Error).message })
      }
    },
  )

  server.tool(
    'grimoire_ingest_pdf',
    'Ingest a PDF document into the Grimoire knowledge graph. Extracts text via AI markdown conversion, chunks, then runs full pipeline.',
    {
      url: z.string().optional().describe('URL to a PDF file'),
      r2_key: z.string().optional().describe('R2 object key for an already-uploaded PDF'),
      pdf_base64: z.string().optional().describe('Base64-encoded PDF content'),
      filename: z.string().optional().describe('Original filename'),
      title: z.string().optional().describe('Override extracted title'),
      source_type: z.enum(['aesthetic', 'domain']).default('domain').describe('Content type'),
      collection_slug: z.string().default('uncategorized').describe('Collection for extracted atoms'),
      tags: z.array(z.string()).optional().describe('Tags for the document'),
      arrangement_hints: z.array(z.string()).optional().describe('Arrangement slugs to hint the tagger'),
      dry_run: z.boolean().default(false).describe('Preview extraction without creating records'),
    },
    async ({ url, r2_key, pdf_base64, filename, title, source_type, collection_slug, tags, arrangement_hints, dry_run }) => {
      if (!url && !r2_key && !pdf_base64) return errText({ error: 'missing_input', message: 'One of url, r2_key, or pdf_base64 is required' })
      try {
        const pipeline = (env as any).HOBBOT_PIPELINE as any
        return text(await pipeline.ingestFromPdf({ url, r2_key, pdf_base64, filename, title, source_type, collection_slug, tags, arrangement_hints, dry_run }))
      } catch (err) {
        return errText({ error: 'pdf_ingest_failed', message: (err as Error).message })
      }
    },
  )

  server.tool(
    'grimoire_ingest_text',
    'Ingest raw text content into the Grimoire knowledge graph. Use for chat excerpts, notes, or pasted content.',
    {
      title: z.string().describe('Title for the document'),
      content: z.string().describe('Raw text content to ingest'),
      source_type: z.enum(['aesthetic', 'domain']).default('domain').describe('Content type'),
      collection_slug: z.string().default('uncategorized').describe('Collection for extracted atoms'),
      tags: z.array(z.string()).optional().describe('Tags for the document'),
      source_url: z.string().optional().describe('Attribution URL (optional)'),
      dry_run: z.boolean().default(false).describe('Preview without creating records'),
    },
    async ({ title, content, source_type, collection_slug, tags, source_url, dry_run }) => {
      try {
        const pipeline = (env as any).HOBBOT_PIPELINE as any
        return text(await pipeline.ingestFromText({ title, content, source_type, collection_slug, tags, dry_run }))
      } catch (err) {
        return errText({ error: 'text_ingest_failed', message: (err as Error).message })
      }
    },
  )

  server.tool(
    'grimoire_ingest_batch',
    'Ingest multiple URLs into the Grimoire knowledge graph sequentially. Max 10 URLs per batch.',
    {
      urls: z.array(z.object({
        url: z.string().describe('URL to ingest'),
        source_type: z.enum(['aesthetic', 'domain']).default('domain').describe('Content type'),
      })).max(10).describe('URLs to ingest (max 10)'),
      collection_slug: z.string().default('uncategorized').describe('Collection for extracted atoms'),
      dry_run: z.boolean().default(false).describe('Preview without creating records'),
    },
    async ({ urls, collection_slug, dry_run }) => {
      try {
        const pipeline = (env as any).HOBBOT_PIPELINE as any
        const results = await pipeline.ingestBatch({ urls, collection_slug, dry_run })
        return text({
          total: (urls as any[]).length,
          succeeded: results.filter((r: any) => !r.errors?.length).length,
          failed: results.filter((r: any) => r.errors?.length > 0).length,
          results,
        })
      } catch (err) {
        return errText({ error: 'batch_ingest_failed', message: (err as Error).message })
      }
    },
  )

  // --- Admin tools (system health, data inspection, model/config) ---
  registerAdminTools(server, env)
  registerAdminWriteTools(server, env)

  return server
}
