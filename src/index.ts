// Grimoire MCP server + API gateway entry point
// Phase 3: all crons, AI providers, R2, pipeline moved to hobbot-pipeline

import { createMcpHandler } from 'agents/mcp'
import { createGrimoireMcpServer } from './mcp/server'
import { handleApiRequest } from './api/routes'
import { buildHealthDigest } from './pipeline/digest'

export interface Env {
  GRIMOIRE_DB: D1Database
  HOBBOT_DB: D1Database
  SERVICE_TOKENS: string
  PROVIDER_HEALTH?: KVNamespace
  GRIMOIRE: Fetcher
  ENVIRONMENT: 'development' | 'production'
  RESEND_API_KEY: string
  HOBBOT_CHAT: Fetcher
  HOBBOT_CUSTODIAN: Service
  HOBBOT_PIPELINE: Service
}

function healthResponse(db: D1Database): Promise<Response> {
  return buildHealthDigest(db).then(digest =>
    new Response(JSON.stringify({ ok: true, ...digest }), {
      headers: { 'Content-Type': 'application/json' },
    })
  )
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp')) {
      const server = createGrimoireMcpServer(env)
      return createMcpHandler(server)(request, env, ctx)
    }

    if (url.pathname === '/') return healthResponse(env.GRIMOIRE_DB)
    if (url.pathname.startsWith('/api/')) return handleApiRequest(request, env)

    return new Response(JSON.stringify({ error: 'not found', code: 404 }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
  },

  // No scheduled handler: all crons moved to hobbot-pipeline worker
}
