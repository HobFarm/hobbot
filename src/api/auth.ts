// Service token validation for API endpoints
// Tokens stored as comma-separated "agent:token" pairs in SERVICE_TOKENS env var

export interface AuthResult {
  valid: boolean
  agent: string | null
}

export function validateServiceToken(request: Request, env: Env): AuthResult {
  const authHeader = request.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return { valid: false, agent: null }
  }

  const token = authHeader.slice(7).trim()
  const tokenList = env.SERVICE_TOKENS ?? ''

  for (const pair of tokenList.split(',')) {
    const colonIdx = pair.indexOf(':')
    if (colonIdx < 1) continue

    const agent = pair.slice(0, colonIdx).trim()
    const secret = pair.slice(colonIdx + 1).trim()

    if (secret === token && agent.length > 0) {
      return { valid: true, agent }
    }
  }

  return { valid: false, agent: null }
}

export function unauthorizedResponse(): Response {
  return new Response(JSON.stringify({ error: 'unauthorized', code: 401 }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  })
}
