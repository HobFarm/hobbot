// Service token validation for API endpoints
// Tokens stored as comma-separated "agent:token" pairs in SERVICE_TOKENS env var

export interface AuthResult {
  valid: boolean
  agent: string | null
}

export async function validateServiceToken(request: Request, env: Env): Promise<AuthResult> {
  const authHeader = request.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return { valid: false, agent: null }
  }

  const token = authHeader.slice(7).trim()

  // Secrets Store bindings may be Fetcher objects (.get()) or plain strings
  let tokenList: string
  const raw = env.SERVICE_TOKENS as unknown
  if (raw && typeof raw === 'object' && 'get' in raw && typeof (raw as { get: unknown }).get === 'function') {
    tokenList = await (raw as { get: () => Promise<string> }).get() ?? ''
  } else {
    tokenList = (raw as string) ?? ''
  }

  for (const pair of tokenList.split(',')) {
    const trimmed = pair.trim()
    if (!trimmed) continue

    const colonIdx = trimmed.indexOf(':')
    if (colonIdx >= 1) {
      // "agent:token" format
      const agent = trimmed.slice(0, colonIdx).trim()
      const secret = trimmed.slice(colonIdx + 1).trim()
      if (secret === token && agent.length > 0) {
        return { valid: true, agent }
      }
    } else {
      // Bare token (no agent prefix)
      if (trimmed === token) {
        return { valid: true, agent: 'default' }
      }
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
