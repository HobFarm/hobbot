// MCP server factory: exposes GrimoireHandle methods as MCP tools
// New McpServer instance per request (SDK 1.26.0 security requirement)

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { createGrimoireHandle } from '../grimoire/handle'
import { ingestAtom } from '../grimoire/ingest'
import { ingestKnowledge } from '../services/knowledge-ingest'
import { analyzeImage } from '../services/image-analysis'
import { checkCategoryExists } from '../state/grimoire'
import type { Env } from '../index'

export function createGrimoireMcpServer(env: Env): McpServer {
  const server = new McpServer({ name: 'Grimoire', version: '1.0.0' })
  const handle = createGrimoireHandle(env.GRIMOIRE_DB)

  // --- Atom queries ---

  server.tool(
    'grimoire_search',
    'Search Grimoire atoms by text query with optional filters',
    {
      q: z.string().describe('Search query text'),
      category: z.string().optional().describe('Filter by category slug'),
      collection: z.string().optional().describe('Filter by collection slug'),
      limit: z.number().min(1).max(100).default(20).describe('Max results to return'),
    },
    async ({ q, category, collection, limit }) => {
      const result = await handle.search(q, { category, collection, limit })
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.tool(
    'grimoire_lookup',
    'Look up a specific atom by exact term',
    { term: z.string().describe('Exact atom term to look up') },
    async ({ term }) => {
      const result = await handle.lookup(term)
      if (!result) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'not_found', message: `No atom found for term: ${term}` }) }],
          isError: true,
        }
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.tool(
    'grimoire_recommend',
    'Get arrangement-aware atom recommendations for a creative intent',
    {
      intent: z.string().describe('Creative intent or concept to get recommendations for'),
      arrangement: z.string().optional().describe('Arrangement slug for style weighting (e.g. "atomic-noir", "cyberpunk")'),
    },
    async ({ intent, arrangement }) => {
      const result = await handle.recommend(intent, arrangement)
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.tool(
    'grimoire_correspondences',
    'Get correspondence graph for a term: related atoms, category siblings, exemplar evidence',
    {
      term: z.string().describe('Atom term to get correspondences for'),
      depth: z.number().min(1).max(5).default(2).describe('Graph traversal depth'),
    },
    async ({ term, depth }) => {
      const result = await handle.correspondences(term, depth)
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
    },
  )

  // --- Taxonomy ---

  server.tool(
    'grimoire_arrangements',
    'List all available arrangements (style profiles) with their harmonic signatures and category weights',
    {},
    async () => {
      const result = await handle.arrangements()
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.tool(
    'grimoire_categories',
    'List all atom categories with descriptions and output schemas',
    {},
    async () => {
      const result = await handle.categories()
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.tool(
    'grimoire_collections',
    'List all atom collections',
    {},
    async () => {
      const result = await handle.collections()
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
    },
  )

  // --- Graph tables ---

  server.tool(
    'grimoire_incantations',
    'List all incantations (structural prompt templates) with their slots',
    {},
    async () => {
      const result = await handle.incantations()
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.tool(
    'grimoire_incantation',
    'Get a specific incantation by slug with its slot structure',
    { slug: z.string().describe('Incantation slug identifier') },
    async ({ slug }) => {
      const result = await handle.incantation(slug)
      if (!result) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'not_found', message: `No incantation found for slug: ${slug}` }) }],
          isError: true,
        }
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.tool(
    'grimoire_exemplars',
    'Get exemplar evidence for a specific atom showing proven usage patterns',
    { atom_id: z.string().describe('Atom ID to get exemplars for') },
    async ({ atom_id }) => {
      const result = await handle.exemplarsFor(atom_id)
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.tool(
    'grimoire_stats',
    'Get Grimoire health stats: atom counts by status, correspondence stats, exemplar count, incantation count',
    {},
    async () => {
      const result = await handle.stats()
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
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
      if (!result.atom) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result.validation, null, 2) }],
          isError: true,
        }
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
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
      try {
        const result = await ingestKnowledge(env, { url, source_type, collection_slug, dry_run })
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'ingest_failed',
            message: (err as Error).message,
          }) }],
          isError: true,
        }
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
        id: crypto.randomUUID(),
        title,
        description: description ?? null,
        mime_type,
        r2_key: r2_key ?? null,
        source_url: source_url ?? null,
        tags: tags ?? [],
        token_count: token_count ?? null,
        chunk_count: 0,
        status: 'pending',
        source_app: source_app ?? null,
      })
      return { content: [{ type: 'text' as const, text: JSON.stringify(doc, null, 2) }] }
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
      // Update document status to chunking on first chunk
      if (chunk_index === 0) {
        await handle.documentUpdateStatus(document_id, 'chunking')
      }
      const chunk = await handle.documentChunkAdd({
        id: crypto.randomUUID(),
        document_id,
        chunk_index,
        content,
        summary: summary ?? null,
        token_count: token_count ?? null,
        category_slug: category_slug ?? null,
        arrangement_slugs: arrangement_slugs ?? [],
        metadata: metadata ?? {},
      })
      return { content: [{ type: 'text' as const, text: JSON.stringify(chunk, null, 2) }] }
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
      if (!result) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'not_found', message: `No document found: ${document_id}` }) }],
          isError: true,
        }
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.document, null, 2) }] }
    },
  )

  server.tool(
    'grimoire_document_search',
    'Search document chunks by text content. Returns matching chunks with their document titles and summaries. Use for finding knowledge about a topic.',
    {
      query: z.string().describe('Search text'),
      category: z.string().optional().describe('Filter by category slug'),
      arrangement: z.string().optional().describe('Filter by arrangement slug'),
      document_id: z.string().optional().describe('Filter to chunks from a specific document'),
      limit: z.number().min(1).max(100).default(20).describe('Max results'),
    },
    async ({ query, category, arrangement, document_id, limit }) => {
      const result = await handle.documentChunkSearch(query, { category, arrangement, document_id, limit })
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.tool(
    'grimoire_document_get',
    "Get a document's metadata and all its chunks.",
    {
      document_id: z.string().describe('Document ID'),
    },
    async ({ document_id }) => {
      const result = await handle.documentGet(document_id)
      if (!result) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'not_found', message: `No document found: ${document_id}` }) }],
          isError: true,
        }
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
    },
  )

  // --- Knowledge Layer: Discovery Queue (Curator) ---

  server.tool(
    'grimoire_discover',
    'Submit a term to the discovery queue for curation. Use instead of direct ingest when the term needs quality review. Sources: stylefusion extraction, hobbot composition, document processing, manual entry.',
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
        id: crypto.randomUUID(),
        term,
        ir_slot: ir_slot ?? null,
        arrangement_slug: arrangement_slug ?? null,
        source_app,
        source_context: source_context ?? {},
        suggested_category: suggested_category ?? null,
        suggested_collection: suggested_collection ?? null,
      })
      return { content: [{ type: 'text' as const, text: JSON.stringify(entry, null, 2) }] }
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
      const result = await handle.discoveryList({ status, source_app, limit })
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.tool(
    'grimoire_queue_resolve',
    'Resolve a discovery queue item. Accept creates a confirmed atom in the Grimoire. Reject discards with a reason. Merge marks as duplicate of an existing atom.',
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
        const result = await handle.discoveryResolve(id, {
          action, note, collection_slug, category_slug,
          observation, confidence, harmonics, duplicate_of_atom_id,
        })
        if (action === 'accept' && !result.atom) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              error: 'validation_failed',
              message: 'Atom failed validation. Entry remains pending.',
              queue_entry: result.queue_entry,
              validation: result.validation,
            }, null, 2) }],
            isError: true,
          }
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'resolve_failed',
            message: (err as Error).message,
          }) }],
          isError: true,
        }
      }
    },
  )

  // --- Knowledge Layer: Atom Relations ---

  server.tool(
    'grimoire_get_related_atoms',
    'Get atoms related to a given atom through typed relations (compositional, oppositional, hierarchical, modifies, co_occurs, derives_from). Returns relation metadata and the related atom details.',
    {
      atom_id: z.string().describe('Atom ID to get relations for'),
      relation_type: z.enum(['compositional', 'oppositional', 'hierarchical', 'modifies', 'co_occurs', 'derives_from']).optional().describe('Filter by relation type'),
      direction: z.enum(['outgoing', 'incoming', 'both']).optional().default('both').describe('Relation direction'),
      limit: z.number().min(1).max(100).default(20).describe('Max results to return'),
    },
    async ({ atom_id, relation_type, direction, limit }) => {
      const result = await handle.getRelatedAtoms(atom_id, { relation_type, direction, limit })
      return { content: [{ type: 'text' as const, text: JSON.stringify({ relations: result }, null, 2) }] }
    },
  )

  server.tool(
    'grimoire_add_relation',
    'Add a typed relation between two atoms. If the exact pair+type+context already exists, updates strength/confidence instead. Relation types: compositional, oppositional, hierarchical, modifies, co_occurs, derives_from.',
    {
      source_atom_id: z.string().describe('Source atom ID'),
      target_atom_id: z.string().describe('Target atom ID'),
      relation_type: z.enum(['compositional', 'oppositional', 'hierarchical', 'modifies', 'co_occurs', 'derives_from']).describe('Type of relation'),
      strength: z.number().min(0).max(1).optional().default(0.5).describe('How strong the relationship is (0-1)'),
      context: z.string().optional().describe('Arrangement slug or domain where the relation holds, e.g. "atomic-noir" or "render_mode=illustration"'),
      source: z.enum(['curated', 'discovered', 'inferred', 'observed']).optional().default('curated').describe('How the relation was created'),
      confidence: z.number().min(0).max(1).optional().default(0.7).describe('How certain we are about this relation (0-1)'),
    },
    async ({ source_atom_id, target_atom_id, relation_type, strength, context, source, confidence }) => {
      try {
        const result = await handle.addRelation({
          source_atom_id, target_atom_id, relation_type,
          strength, context: context ?? null, source, confidence,
        })
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'add_relation_failed', message: (err as Error).message }) }],
          isError: true,
        }
      }
    },
  )

  // --- Knowledge Layer: Provider Behaviors ---

  server.tool(
    'grimoire_get_provider_behaviors',
    'Get tracked provider behavior observations. Filter by provider, atom, category, render mode, or severity.',
    {
      provider: z.string().optional().describe('Filter by provider name (e.g. "grok_imagine", "gemini_image_app")'),
      atom_id: z.string().optional().describe('Filter by specific atom ID'),
      atom_category: z.string().optional().describe('Filter by atom category slug'),
      render_mode: z.string().optional().describe('Filter by render mode (e.g. "photorealistic", "illustration")'),
      severity: z.enum(['info', 'warning', 'breaking']).optional().describe('Filter by severity level'),
    },
    async ({ provider, atom_id, atom_category, render_mode, severity }) => {
      const result = await handle.getProviderBehaviors({ provider, atom_id, atom_category, render_mode, severity })
      return { content: [{ type: 'text' as const, text: JSON.stringify({ behaviors: result }, null, 2) }] }
    },
  )

  server.tool(
    'grimoire_log_provider_behavior',
    'Log a provider behavior observation. Track how specific image generation providers interpret atoms, categories, or render modes.',
    {
      provider: z.string().describe('Provider name (e.g. "grok_imagine", "nano_banana_2", "gemini_image_app")'),
      atom_id: z.string().optional().describe('Specific atom ID this behavior relates to'),
      atom_category: z.string().optional().describe('Atom category this behavior applies to'),
      behavior: z.string().describe('Description of the observed behavior'),
      render_mode: z.string().optional().describe('Render mode context (e.g. "photorealistic", "illustration")'),
      severity: z.enum(['info', 'warning', 'breaking']).optional().default('info').describe('Severity: info (neutral), warning (drift risk), breaking (avoid this combination)'),
    },
    async ({ provider, atom_id, atom_category, behavior, render_mode, severity }) => {
      try {
        const result = await handle.logProviderBehavior({
          provider, atom_id: atom_id ?? null, atom_category: atom_category ?? null,
          behavior, render_mode: render_mode ?? null, severity,
        })
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'log_behavior_failed', message: (err as Error).message }) }],
          isError: true,
        }
      }
    },
  )

  // --- Image Analysis ---

  server.tool(
    'grimoire_classify_image',
    'Classify an image against Grimoire arrangements and aesthetics. Returns ranked matches and extracted visual vocabulary. Does NOT create atoms; use grimoire_ingest_image for that.',
    {
      image_base64: z.string().optional().describe('Base64-encoded image data'),
      image_url: z.string().optional().describe('Public URL of image to analyze'),
      r2_key: z.string().optional().describe('R2 key (fetched via cdn.hob.farm)'),
      mime_type: z.string().default('image/jpeg').describe('Image MIME type'),
    },
    async ({ image_base64, image_url, r2_key, mime_type }) => {
      if (!image_base64 && !image_url && !r2_key) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'missing_input', message: 'One of image_base64, image_url, or r2_key is required' }) }],
          isError: true,
        }
      }
      try {
        const analysis = await analyzeImage(env, { image_base64, image_url, r2_key, mime_type })
        return { content: [{ type: 'text' as const, text: JSON.stringify(analysis, null, 2) }] }
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'classify_failed', message: (err as Error).message }) }],
          isError: true,
        }
      }
    },
  )

  server.tool(
    'grimoire_ingest_image',
    'Analyze image, extract visual atoms, store as Grimoire source with provenance. Atoms created as provisional, auto-classified and vectorized by cron.',
    {
      image_base64: z.string().optional().describe('Base64-encoded image data'),
      image_url: z.string().optional().describe('Public URL of image to analyze'),
      r2_key: z.string().optional().describe('R2 key (fetched via cdn.hob.farm)'),
      mime_type: z.string().default('image/jpeg').describe('Image MIME type'),
      type: z.enum(['moodboard', 'reference', 'generation']).default('reference').describe('Source type'),
      filename: z.string().optional().describe('Original filename for reference'),
      collection_slug: z.string().default('uncategorized').describe('Collection for extracted atoms'),
      dry_run: z.boolean().default(false).describe('Preview extraction without creating atoms'),
    },
    async ({ image_base64, image_url, r2_key, mime_type, type, filename, collection_slug, dry_run }) => {
      if (!image_base64 && !image_url && !r2_key) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'missing_input', message: 'One of image_base64, image_url, or r2_key is required' }) }],
          isError: true,
        }
      }

      try {
        // 1. Analyze image via Gemini Vision
        const analysis = await analyzeImage(env, { image_base64, image_url, r2_key, mime_type })

        // 2. Collect all extracted atoms
        const allAtoms = [
          ...analysis.visual_atoms,
          ...analysis.color_atoms,
          ...analysis.material_atoms,
          ...analysis.atmospheric_atoms,
        ]

        const atomsCreated: { id: string; text: string }[] = []
        const atomsSkipped: string[] = []
        const sourceId = crypto.randomUUID()

        if (!dry_run) {
          // 3. Create source record
          await handle.sourceAdd({
            id: sourceId,
            type,
            filename: filename ?? null,
            mime_type: mime_type ?? null,
            r2_key: r2_key ?? null,
            source_url: image_url ?? null,
            metadata: analysis as unknown as Record<string, unknown>,
            aesthetic_tags: analysis.aesthetic_tags,
            arrangement_matches: analysis.arrangement_matches,
            harmonic_profile: analysis.harmonic_profile as unknown as Record<string, string>,
            atom_count: 0,
            created_at: new Date().toISOString(),
          })

          // 4. Insert atoms and create junction records
          for (const extracted of allAtoms) {
            const text = extracted.text?.trim()
            if (!text || text.length < 2) continue

            // Dedup: lookup searches by text_lower
            const existing = await handle.lookup(text)
            if (existing) {
              atomsSkipped.push(text)
              // Still link existing atom to this source
              await handle.sourceAtomLink(sourceId, existing.id, 1.0, 'gemini_vision')
              continue
            }

            // Validate category_hint against categories table
            let categorySlug: string | undefined
            if (extracted.category_hint) {
              const hintValid = await checkCategoryExists(env.GRIMOIRE_DB, extracted.category_hint)
              if (hintValid) {
                categorySlug = extracted.category_hint
              }
            }

            const result = await ingestAtom(env.GRIMOIRE_DB, {
              text,
              collection_slug: collection_slug,
              category_slug: categorySlug ?? null,
              source: 'ai',
              source_app: 'image-ingest',
              confidence: 0.6,
              observation: 'observation',
              metadata: { source_image: sourceId },
            })

            if (result.atom) {
              atomsCreated.push({ id: result.atom.id, text: result.atom.text })
              await handle.sourceAtomLink(sourceId, result.atom.id, 1.0, 'gemini_vision')
            } else {
              atomsSkipped.push(text)
            }
          }

          // 5. Update atom count on source
          const totalLinked = atomsCreated.length + atomsSkipped.length
          await handle.sourceUpdateAtomCount(sourceId, totalLinked)
        } else {
          // Dry run: check what would be created vs skipped
          for (const extracted of allAtoms) {
            const text = extracted.text?.trim()
            if (!text || text.length < 2) continue
            const existing = await handle.lookup(text)
            if (existing) {
              atomsSkipped.push(text)
            } else {
              atomsCreated.push({ id: '(dry_run)', text })
            }
          }
        }

        const response = {
          source_id: dry_run ? '(dry_run)' : sourceId,
          type,
          analysis: {
            image_type: analysis.image_type,
            description: analysis.description,
            aesthetic_tags: analysis.aesthetic_tags,
            arrangement_matches: analysis.arrangement_matches,
            harmonic_profile: analysis.harmonic_profile,
            dominant_colors: analysis.dominant_colors,
          },
          atoms_created: atomsCreated,
          atoms_skipped: atomsSkipped,
          total_extracted: allAtoms.length,
          dry_run,
        }

        return { content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }] }
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'ingest_failed', message: (err as Error).message }) }],
          isError: true,
        }
      }
    },
  )

  return server
}
