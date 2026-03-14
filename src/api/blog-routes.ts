// Review and promote endpoints for blog drafts
// Blog pipeline/bridge/publish delegated to hobbot-pipeline worker via RPC.
// Draft CRUD stays here (direct HOBBOT_DB, no AI deps).

import type { Env } from '../index'

interface BlogPostRow {
  id: number
  title: string
  slug: string
  excerpt: string | null
  body_md: string
  tags: string
  category: string
  channel: string
  status: string
  created_at: string
  updated_at: string | null
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function err(message: string, code: number): Response {
  return json({ error: message, code }, code)
}

export async function handleBlogRequest(
  request: Request,
  env: Env,
  path: string,
  segments: string[]
): Promise<Response> {
  const url = new URL(request.url)

  // POST /api/v1/blog/run — manual pipeline trigger (delegated to pipeline worker)
  if (path === '/api/v1/blog/run' && request.method === 'POST') {
    const channel = url.searchParams.get('channel') ?? 'blog'
    const pipeline = (env as any).HOBBOT_PIPELINE as any
    const result = await pipeline.runBlogPipeline(channel)
    return json(result)
  }

  // POST /api/v1/blog/bridge — manual bridge trigger (delegated to pipeline worker)
  if (path === '/api/v1/blog/bridge' && request.method === 'POST') {
    const pipeline = (env as any).HOBBOT_PIPELINE as any
    const result = await pipeline.runBridge()
    return json(result)
  }

  // GET /api/v1/blog/drafts — list all drafts
  if (path === '/api/v1/blog/drafts' && request.method === 'GET') {
    const channel = url.searchParams.get('channel')
    const query = channel
      ? `SELECT id, title, slug, category, channel, status, created_at FROM blog_posts WHERE status = 'draft' AND channel = ? ORDER BY created_at DESC`
      : `SELECT id, title, slug, category, channel, status, created_at FROM blog_posts WHERE status = 'draft' ORDER BY created_at DESC`
    const result = channel
      ? await env.HOBBOT_DB.prepare(query).bind(channel).all()
      : await env.HOBBOT_DB.prepare(query).all()
    return json(result.results ?? [])
  }

  // Routes that operate on a specific draft by id
  // segments: ['api', 'v1', 'blog', 'drafts', ':id', ...?]
  if (segments[2] === 'blog' && segments[3] === 'drafts' && segments[4]) {
    const id = parseInt(segments[4], 10)
    if (isNaN(id)) return err('invalid draft id', 400)

    // GET /api/v1/blog/drafts/:id — full draft
    if (request.method === 'GET' && !segments[5]) {
      const post = await env.HOBBOT_DB
        .prepare(`SELECT * FROM blog_posts WHERE id = ?`)
        .bind(id)
        .first<BlogPostRow>()
      if (!post) return err('draft not found', 404)
      return json(post)
    }

    // PATCH /api/v1/blog/drafts/:id — update editable fields
    if (request.method === 'PATCH' && !segments[5]) {
      let body: Record<string, unknown>
      try { body = await request.json() as Record<string, unknown> } catch { return err('invalid JSON body', 400) }

      const allowed = ['title', 'excerpt', 'body_md', 'tags'] as const
      const sets: string[] = []
      const binds: unknown[] = []

      for (const field of allowed) {
        if (field in body) {
          if (field === 'tags' && Array.isArray(body.tags)) {
            sets.push(`tags = ?`)
            binds.push(JSON.stringify(body.tags))
          } else if (typeof body[field] === 'string') {
            sets.push(`${field} = ?`)
            binds.push(body[field])
          }
        }
      }

      if (sets.length === 0) return err('no updatable fields provided', 400)

      sets.push(`updated_at = datetime('now')`)
      binds.push(id)

      await env.HOBBOT_DB
        .prepare(`UPDATE blog_posts SET ${sets.join(', ')} WHERE id = ? AND status = 'draft'`)
        .bind(...binds)
        .run()

      const updated = await env.HOBBOT_DB
        .prepare(`SELECT * FROM blog_posts WHERE id = ?`)
        .bind(id)
        .first<BlogPostRow>()
      return json(updated)
    }

    // POST /api/v1/blog/drafts/:id/publish — delegated to pipeline worker
    if (request.method === 'POST' && segments[5] === 'publish') {
      try {
        const pipeline = (env as any).HOBBOT_PIPELINE as any
        const result = await pipeline.publishDraft(id)
        return json(result)
      } catch (error) {
        const msg = (error as Error).message
        if (msg.includes('not found')) return err('draft not found', 404)
        if (msg.includes('not draft')) return err(msg, 409)
        return json({ error: msg, code: 500 }, 500)
      }
    }

    // DELETE /api/v1/blog/drafts/:id — mark as rejected
    if (request.method === 'DELETE' && !segments[5]) {
      await env.HOBBOT_DB
        .prepare(`UPDATE blog_posts SET status = 'rejected', updated_at = datetime('now') WHERE id = ?`)
        .bind(id)
        .run()
      return json({ rejected: true, id })
    }
  }

  return err('not found', 404)
}
