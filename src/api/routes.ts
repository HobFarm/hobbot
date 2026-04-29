// HTTP API router for GrimoireHandle endpoints
// All responses are JSON. Errors: { error: string, code: number }

import { createGrimoireHandle } from '../grimoire/handle'
import { ingestAtom } from '../grimoire/ingest'
import { logUsage } from '../grimoire/telemetry'
import { validateServiceToken, unauthorizedResponse } from './auth'
import { handleSubscribeRequest, handleConfirmRequest, handleUnsubscribeRequest } from './subscribe'
import { handleBlogRequest } from './blog-routes'
import { buildHealthDigest } from '../pipeline/digest'
import { QUERY } from '../config'
import type { Env } from '../index'
import type { CorrespondenceQueryOptions } from '../grimoire/types'

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function err(message: string, code: number): Response {
  return json({ error: message, code }, code)
}

export async function handleApiRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname
  const segments = path.split('/').filter(Boolean) // ['api', 'v1', 'resource', 'slug?']

  // Public endpoints: no auth required
  if (path === '/api/v1/health' && request.method === 'GET') {
    const digest = await buildHealthDigest(env.GRIMOIRE_DB)
    return json(digest)
  }

  // Newsletter endpoints (public)
  if (path === '/api/subscribe') return handleSubscribeRequest(request, env)
  if (path === '/api/confirm' && request.method === 'GET') return handleConfirmRequest(request, env)
  if (path === '/api/unsubscribe' && request.method === 'GET') return handleUnsubscribeRequest(request, env)

  // Chat routes proxied to hobbot-chat worker via service binding.
  // Chat uses JWT auth (CF Access), not service tokens.
  if (path.startsWith('/api/chat/')) {
    return env.HOBBOT_CHAT.fetch(request)
  }

  // All other /api/v1/* require auth
  const auth = await validateServiceToken(request, env)
  if (!auth.valid) return unauthorizedResponse()

  const agent = auth.agent!
  const start = Date.now()
  const handle = createGrimoireHandle(env.GRIMOIRE_DB)

  try {
    // --- Admin ---

    if (path === '/api/v1/admin/process-discovery' && request.method === 'POST') {
      const custodian = env.HOBBOT_CUSTODIAN as any
      const result = await custodian.processDiscovery()
      return json(result)
    }

    // GET /api/v1/admin/harvest-health/:collection_slug
    if (segments[2] === 'admin' && segments[3] === 'harvest-health' && segments[4] && request.method === 'GET') {
      const custodian = env.HOBBOT_CUSTODIAN as any
      const report = await custodian.harvestHealth(segments[4])
      return json(report)
    }

    // POST /api/v1/admin/build-correspondences/:source_id
    if (segments[2] === 'admin' && segments[3] === 'build-correspondences' && segments[4] && request.method === 'POST') {
      const custodian = env.HOBBOT_CUSTODIAN as any
      const result = await custodian.buildCorrespondences(segments[4])
      return json(result)
    }

    // POST /api/v1/admin/repair-chunk-links
    // One-time repair: link existing source_atoms to their chunks via substring matching
    if (path === '/api/v1/admin/repair-chunk-links' && request.method === 'POST') {
      const db = env.GRIMOIRE_DB

      // Find source_atoms with no chunk_id that have a source with a document
      const orphans = await db.prepare(`
        SELECT sa.rowid, sa.source_id, sa.atom_id, a.text_lower,
               s.document_id
        FROM source_atoms sa
        JOIN atoms a ON sa.atom_id = a.id
        JOIN sources s ON sa.source_id = s.id
        WHERE sa.chunk_id IS NULL
          AND s.document_id IS NOT NULL
        LIMIT 500
      `).all<{ rowid: number; source_id: string; atom_id: string; text_lower: string; document_id: string }>()

      let repaired = 0
      let skipped = 0

      for (const orphan of orphans.results ?? []) {
        // Load chunks for this document
        const chunks = await db.prepare(
          `SELECT id, content FROM document_chunks WHERE document_id = ? ORDER BY chunk_index`
        ).bind(orphan.document_id).all<{ id: string; content: string }>()

        const matchingChunk = (chunks.results ?? []).find(c =>
          c.content.toLowerCase().includes(orphan.text_lower)
        )

        if (matchingChunk) {
          await db.prepare(
            `UPDATE source_atoms SET chunk_id = ?, extraction_context = 'repair' WHERE source_id = ? AND atom_id = ?`
          ).bind(matchingChunk.id, orphan.source_id, orphan.atom_id).run()
          repaired++
        } else {
          skipped++
        }
      }

      return json({ repaired, skipped, total_checked: (orphans.results ?? []).length })
    }

    // POST /api/v1/admin/harvest/:source_id
    if (segments[2] === 'admin' && segments[3] === 'harvest' && segments[4] && request.method === 'POST') {
      const custodian = env.HOBBOT_CUSTODIAN as any
      const body = await request.json().catch(() => ({})) as Record<string, unknown>
      const batchSize = typeof body.batch_size === 'number' ? body.batch_size : 50
      const result = await custodian.harvest(segments[4], batchSize)
      return json(result)
    }

    // POST /api/v1/admin/conductor
    if (path === '/api/v1/admin/conductor' && request.method === 'POST') {
      const custodian = env.HOBBOT_CUSTODIAN as any
      const result = await custodian.runConductor()
      return json(result)
    }

    // POST /api/v1/admin/agent/:name
    if (segments[2] === 'admin' && segments[3] === 'agent' && segments[4] && request.method === 'POST') {
      const custodian = env.HOBBOT_CUSTODIAN as any
      const result = await custodian.runAgent(segments[4])
      return json(result)
    }

    // GET /api/v1/admin/knowledge-requests?status=pending
    if (path === '/api/v1/admin/knowledge-requests' && request.method === 'GET') {
      const custodian = env.HOBBOT_CUSTODIAN as any
      const status = url.searchParams.get('status') ?? undefined
      const result = await custodian.listKnowledgeRequests(status)
      return json(result)
    }

    // --- Atom queries ---

    if (path === '/api/v1/lookup' && request.method === 'GET') {
      const term = url.searchParams.get('term')
      if (!term) return err('term is required', 400)
      const atom = await handle.lookup(term)
      await logUsage(env.GRIMOIRE_DB, { agent, endpoint: 'lookup', query: term, atomIdsReturned: atom ? [atom.id] : [], responseTimeMs: Date.now() - start })
      return atom ? json(atom) : err('not found', 404)
    }

    if (path === '/api/v1/search' && request.method === 'GET') {
      const q = url.searchParams.get('q') ?? ''
      const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20'), QUERY.MAX_SEARCH_LIMIT)
      const atoms = await handle.search(q, {
        category: url.searchParams.get('category') ?? undefined,
        collection: url.searchParams.get('collection') ?? undefined,
        modality: url.searchParams.get('modality') as 'visual' | 'both' | undefined,
        status: url.searchParams.get('status') as 'provisional' | 'confirmed' | 'rejected' | undefined,
        limit,
      })
      await logUsage(env.GRIMOIRE_DB, { agent, endpoint: 'search', query: q, atomIdsReturned: atoms.map(a => a.id), responseTimeMs: Date.now() - start })
      return json(atoms)
    }

    if (path === '/api/v1/correspondences' && request.method === 'GET') {
      // atom_id param: raw correspondence query against correspondences table
      const atomId = url.searchParams.get('atom_id')
      if (atomId) {
        const opts: CorrespondenceQueryOptions = {
          relationship_type: url.searchParams.get('type') as CorrespondenceQueryOptions['relationship_type'] ?? undefined,
          provenance: url.searchParams.get('provenance') as CorrespondenceQueryOptions['provenance'] ?? undefined,
          min_strength: url.searchParams.get('min_strength') ? parseFloat(url.searchParams.get('min_strength')!) : undefined,
          limit: url.searchParams.get('limit') ? parseInt(url.searchParams.get('limit')!) : undefined,
        }
        const corrs = await handle.correspondencesRaw(atomId, opts)
        await logUsage(env.GRIMOIRE_DB, { agent, endpoint: 'correspondences_raw', query: atomId, atomIdsReturned: [], responseTimeMs: Date.now() - start })
        return json(corrs)
      }
      // term param: high-level CorrespondenceResult with siblings and exemplars
      const term = url.searchParams.get('term')
      if (!term) return err('term or atom_id is required', 400)
      const depth = parseInt(url.searchParams.get('depth') ?? '2')
      const result = await handle.correspondences(term, depth)
      await logUsage(env.GRIMOIRE_DB, { agent, endpoint: 'correspondences', query: term, atomIdsReturned: result.correspondences.map(c => c.id), responseTimeMs: Date.now() - start })
      return json(result)
    }

    if (path === '/api/v1/recommend' && request.method === 'GET') {
      const intent = url.searchParams.get('intent') ?? ''
      const arrangement = url.searchParams.get('arrangement') ?? undefined
      const atoms = await handle.recommend(intent, arrangement)
      await logUsage(env.GRIMOIRE_DB, { agent, endpoint: 'recommend', query: intent, atomIdsReturned: atoms.map(a => a.id), responseTimeMs: Date.now() - start })
      return json(atoms)
    }

    if (path === '/api/v1/route' && request.method === 'GET') {
      const task = url.searchParams.get('task')
      if (!task) return err('task is required', 400)
      return json(await handle.route(task))
    }

    // --- Taxonomy ---

    if (path === '/api/v1/categories' && request.method === 'GET') {
      return json(await handle.categories())
    }

    if (path === '/api/v1/collections' && request.method === 'GET') {
      return json(await handle.collections())
    }

    if (path === '/api/v1/arrangements' && request.method === 'GET') {
      return json(await handle.arrangements())
    }

    // --- Phase 1 graph tables ---

    // /api/v1/incantations or /api/v1/incantations/:slug
    if (segments[2] === 'incantations' && request.method === 'GET') {
      const slug = segments[3]
      if (slug) {
        const incantation = await handle.incantation(slug)
        return incantation ? json(incantation) : err('not found', 404)
      }
      return json(await handle.incantations())
    }

    if (path === '/api/v1/exemplars' && request.method === 'GET') {
      const atomId = url.searchParams.get('atom_id')
      if (!atomId) return err('atom_id is required', 400)
      return json(await handle.exemplarsFor(atomId))
    }

    if (path === '/api/v1/category-relations' && request.method === 'GET') {
      const slug = url.searchParams.get('slug') ?? undefined
      return json(await handle.categoryRelations(slug))
    }

    if (path === '/api/v1/stats' && request.method === 'GET') {
      return json(await handle.stats())
    }

    // --- Write path ---

    if (path === '/api/v1/ingest' && request.method === 'POST') {
      let body: unknown
      try { body = await request.json() } catch { return err('invalid JSON body', 400) }
      const result = await ingestAtom(env.GRIMOIRE_DB, body as Record<string, unknown>)
      const status = result.atom ? 201 : 422
      return json(result, status)
    }

    // --- Text Ingest (delegated to pipeline worker) ---

    if (path === '/api/v1/ingest/text' && request.method === 'POST') {
      let body: Record<string, unknown>
      try { body = await request.json() as Record<string, unknown> } catch { return err('invalid JSON body', 400) }
      if (!body.title || typeof body.title !== 'string') return err('title is required', 400)
      if (!body.content || typeof body.content !== 'string') return err('content is required', 400)

      try {
        const pipeline = env.HOBBOT_PIPELINE as any
        const result = await pipeline.ingestFromText({
          title: body.title,
          content: body.content,
          source_type: (body.source_type as string) ?? 'domain',
          collection_slug: body.collection_slug as string | undefined,
          tags: body.tags as string[] | undefined,
          dry_run: body.dry_run as boolean | undefined,
        })
        return json(result, 201)
      } catch (error) {
        return json({ error: (error as Error).message, code: 500 }, 500)
      }
    }

    // --- Knowledge Ingest Pipeline (delegated to pipeline worker) ---

    if (path === '/api/v1/ingest/knowledge' && request.method === 'POST') {
      let body: Record<string, unknown>
      try { body = await request.json() as Record<string, unknown> } catch { return err('invalid JSON body', 400) }
      if (!body.url || typeof body.url !== 'string') return err('url is required', 400)

      try {
        const pipeline = env.HOBBOT_PIPELINE as any
        const result = await pipeline.ingestFromUrl({
          url: body.url,
          source_type: (body.source_type as string) ?? 'aesthetic',
          collection_slug: body.collection_slug as string | undefined,
          dry_run: body.dry_run as boolean | undefined,
        })
        return json(result, 201)
      } catch (error) {
        return json({ error: (error as Error).message, code: 500 }, 500)
      }
    }

    if (path === '/api/v1/ingest/knowledge/batch' && request.method === 'POST') {
      let body: Record<string, unknown>
      try { body = await request.json() as Record<string, unknown> } catch { return err('invalid JSON body', 400) }

      const urls = body.urls as Array<{ url: string; source_type?: string }> | undefined
      if (!Array.isArray(urls) || urls.length === 0) return err('urls array is required', 400)
      if (urls.length > 10) return err('maximum 10 URLs per batch', 400)

      try {
        const pipeline = env.HOBBOT_PIPELINE as any
        const results = await pipeline.ingestBatch({
          urls,
          collection_slug: body.collection_slug as string | undefined,
          dry_run: body.dry_run as boolean | undefined,
        })
        return json({ results }, 200)
      } catch (error) {
        return json({ error: (error as Error).message, code: 500 }, 500)
      }
    }

    if (path === '/api/v1/ingest/pdf' && request.method === 'POST') {
      let body: Record<string, unknown>
      try { body = await request.json() as Record<string, unknown> } catch { return err('invalid JSON body', 400) }
      if (!body.url && !body.r2_key && !body.pdf_base64) return err('url, r2_key, or pdf_base64 required', 400)

      try {
        const pipeline = env.HOBBOT_PIPELINE as any
        const result = await pipeline.ingestFromPdf(body)
        return json(result, 201)
      } catch (error) {
        return json({ error: (error as Error).message, code: 500 }, 500)
      }
    }

    if (path === '/api/v1/ingest/knowledge/history' && request.method === 'GET') {
      const logs = await handle.ingestLogList({
        status: url.searchParams.get('status') ?? undefined,
        source_type: url.searchParams.get('source_type') ?? undefined,
        limit: url.searchParams.get('limit') ? parseInt(url.searchParams.get('limit')!) : undefined,
      })
      return json(logs)
    }

    // --- Atom Relations ---

    // GET /api/v1/relations/:atom_id?type=&direction=&limit=
    if (segments[2] === 'relations' && segments[3] && request.method === 'GET') {
      const atomId = segments[3]
      const relations = await handle.getRelatedAtoms(atomId, {
        relation_type: url.searchParams.get('type') ?? undefined,
        direction: (url.searchParams.get('direction') as 'outgoing' | 'incoming' | 'both') ?? undefined,
        limit: url.searchParams.get('limit') ? parseInt(url.searchParams.get('limit')!) : undefined,
      })
      return json({ relations })
    }

    // POST /api/v1/relations
    if (path === '/api/v1/relations' && request.method === 'POST') {
      let body: Record<string, unknown>
      try { body = await request.json() as Record<string, unknown> } catch { return err('invalid JSON body', 400) }
      if (!body.source_atom_id || !body.target_atom_id || !body.relation_type) {
        return err('source_atom_id, target_atom_id, and relation_type are required', 400)
      }
      const result = await handle.addRelation({
        source_atom_id: body.source_atom_id as string,
        target_atom_id: body.target_atom_id as string,
        relation_type: body.relation_type as string,
        strength: body.strength as number | undefined,
        context: (body.context as string) ?? null,
        source: body.source as string | undefined,
        confidence: body.confidence as number | undefined,
      } as Parameters<typeof handle.addRelation>[0])
      return json(result, result.created ? 201 : 200)
    }

    // --- Provider Behaviors ---

    // GET /api/v1/provider-behaviors?provider=&atom_id=&category=&render_mode=&severity=
    if (path === '/api/v1/provider-behaviors' && request.method === 'GET') {
      const behaviors = await handle.getProviderBehaviors({
        provider: url.searchParams.get('provider') ?? undefined,
        atom_id: url.searchParams.get('atom_id') ?? undefined,
        atom_category: url.searchParams.get('category') ?? undefined,
        render_mode: url.searchParams.get('render_mode') ?? undefined,
        severity: url.searchParams.get('severity') ?? undefined,
      })
      return json({ behaviors })
    }

    // POST /api/v1/provider-behaviors
    if (path === '/api/v1/provider-behaviors' && request.method === 'POST') {
      let body: Record<string, unknown>
      try { body = await request.json() as Record<string, unknown> } catch { return err('invalid JSON body', 400) }
      if (!body.provider || !body.behavior) {
        return err('provider and behavior are required', 400)
      }
      const result = await handle.logProviderBehavior({
        provider: body.provider as string,
        atom_id: (body.atom_id as string) ?? null,
        atom_category: (body.atom_category as string) ?? null,
        behavior: body.behavior as string,
        render_mode: (body.render_mode as string) ?? null,
        severity: body.severity as 'info' | 'warning' | 'breaking' | undefined,
      })
      return json(result, 201)
    }

    if (path.startsWith('/api/v1/blog')) {
      return handleBlogRequest(request, env, path, segments)
    }

    return err('not found', 404)
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'internal error'
    console.error(`api_error: path=${path} error=${msg}`)
    return err('internal server error', 500)
  }
}
