// Newsletter subscription endpoints
// POST /api/subscribe, GET /api/confirm, GET /api/unsubscribe

import type { Env } from '../index'

const ALLOWED_ORIGINS = ['https://hob.farm', 'https://www.hob.farm', 'http://localhost:4321']
const RATE_LIMIT_MAX = 5
const RATE_LIMIT_TTL = 3600

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  }
}

function jsonResponse(data: unknown, status = 200, origin: string | null = null): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  })
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function validateEmail(email: unknown): string | null {
  if (typeof email !== 'string') return null
  const trimmed = email.trim().toLowerCase()
  if (trimmed.length === 0 || trimmed.length > 254) return null
  if (!EMAIL_RE.test(trimmed)) return null
  return trimmed
}

// --- Rate Limiting via KV (fail-open with timeout) ---

async function checkRateLimit(kv: KVNamespace | undefined, ip: string): Promise<boolean> {
  if (!kv) return true
  try {
    const key = `ratelimit:subscribe:${ip}`
    // Race against a 3s timeout so KV can never hang the request
    const result = await Promise.race([
      (async () => {
        const current = parseInt(await kv.get(key) ?? '0', 10)
        if (current >= RATE_LIMIT_MAX) return false
        await kv.put(key, String(current + 1), { expirationTtl: RATE_LIMIT_TTL })
        return true
      })(),
      new Promise<boolean>(resolve => setTimeout(() => resolve(true), 3000)),
    ])
    return result
  } catch (e) {
    console.error(`ratelimit_error: ${e instanceof Error ? e.message : e}`)
    return true // fail open
  }
}

// --- Confirmation Email ---

function buildConfirmationEmail(token: string): string {
  const confirmUrl = `https://hobbot-worker.damp-violet-bf89.workers.dev/api/confirm?token=${token}`
  const unsubscribeUrl = `https://hobbot-worker.damp-violet-bf89.workers.dev/api/unsubscribe?token=${token}`
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background-color:#0a0a0a;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0a0a0a;">
<tr><td align="center" style="padding:40px 20px;">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background-color:#1a1a1a;border-radius:8px;max-width:480px;width:100%;">
<tr><td style="padding:40px 32px;">

<p style="margin:0 0 8px;font-size:20px;font-weight:600;color:#f5f5f5;">HobFarm</p>
<p style="margin:0 0 24px;font-size:13px;color:#737373;letter-spacing:1px;text-transform:uppercase;">Newsletter</p>

<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#d4d4d4;">
Thanks for subscribing to HobFarm updates.
</p>
<p style="margin:0 0 32px;font-size:15px;line-height:1.6;color:#d4d4d4;">
Click below to confirm your subscription:
</p>

<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 32px;">
<tr><td style="border-radius:6px;background-color:#9333ea;">
<a href="${confirmUrl}" target="_blank" style="display:inline-block;padding:14px 32px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px;">
Confirm Subscription
</a>
</td></tr>
</table>

<p style="margin:0 0 8px;font-size:12px;color:#737373;">
If you didn't request this, just ignore this email.
</p>
<p style="margin:0;font-size:12px;color:#525252;">
<a href="${unsubscribeUrl}" style="color:#525252;text-decoration:underline;">Unsubscribe</a>
</p>

</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`
}

// --- Styled HTML Pages ---

function styledPage(title: string, heading: string, message: string, linkText = 'Back to HobFarm', linkUrl = 'https://hob.farm'): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="margin:0;padding:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background-color:#0a0a0a;font-family:Arial,Helvetica,sans-serif;">
<div style="max-width:480px;width:100%;margin:0 20px;padding:48px 32px;background-color:#1a1a1a;border-radius:8px;text-align:center;">
<p style="margin:0 0 24px;font-size:24px;font-weight:300;color:#f5f5f5;">${heading}</p>
<p style="margin:0 0 32px;font-size:15px;line-height:1.6;color:#d4d4d4;">${message}</p>
<a href="${linkUrl}" style="display:inline-block;padding:12px 24px;background-color:#9333ea;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">${linkText}</a>
</div>
</body>
</html>`
}

// --- Handlers ---

export async function handleSubscribeRequest(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get('Origin')

  // Preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) })
  }

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'method not allowed' }, 405, origin)
  }

  try {
    // Rate limit (fail-open)
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
    const allowed = await checkRateLimit(env.PROVIDER_HEALTH, ip)
    if (!allowed) {
      return jsonResponse({ error: 'Too many requests. Try again later.' }, 429, origin)
    }

    let body: Record<string, unknown>
    try {
      body = await request.json() as Record<string, unknown>
    } catch {
      return jsonResponse({ error: 'Invalid request body.' }, 400, origin)
    }

    // Honeypot
    if (body.website && typeof body.website === 'string' && body.website.length > 0) {
      return jsonResponse({ success: true, message: 'Check your email to confirm.' }, 200, origin)
    }

    const email = validateEmail(body.email)
    if (!email) {
      return jsonResponse({ error: 'Please enter a valid email address.' }, 400, origin)
    }

    const db = env.HOBBOT_DB
    const token = crypto.randomUUID()

    // Check existing subscriber
    const existing = await db.prepare('SELECT id, status, token FROM subscribers WHERE email = ?').bind(email).first<{
      id: number
      status: string
      token: string
    }>()

    if (existing) {
      if (existing.status === 'confirmed') {
        return jsonResponse({ success: true, message: "You're already subscribed." }, 200, origin)
      }

      // pending or unsubscribed: update token and resend
      await db.prepare(
        `UPDATE subscribers SET status = 'pending', token = ?, subscribed_at = datetime('now'), unsubscribed_at = NULL WHERE id = ?`
      ).bind(token, existing.id).run()
    } else {
      await db.prepare(
        `INSERT INTO subscribers (email, status, token, source) VALUES (?, 'pending', ?, 'website')`
      ).bind(email, token).run()
    }

    // Send confirmation email via Resend
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: 'HobFarm <hey@hob.farm>',
          to: email,
          subject: 'Confirm your HobFarm subscription',
          html: buildConfirmationEmail(token),
        }),
      })

      if (!res.ok) {
        const errBody = await res.text()
        console.error(`resend_error: status=${res.status} body=${errBody}`)
      }
    } catch (e) {
      console.error(`resend_fetch_error: ${e instanceof Error ? e.message : e}`)
    }

    return jsonResponse({ success: true, message: 'Check your email to confirm.' }, 200, origin)
  } catch (err) {
    console.error(`subscribe_handler_error: ${err instanceof Error ? err.message : err}`)
    return jsonResponse({ success: false, message: 'Internal error' }, 500, origin)
  }
}

export async function handleConfirmRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const token = url.searchParams.get('token')

  if (!token) {
    return htmlResponse(styledPage('Error', 'Invalid Link', 'This confirmation link is invalid or has expired.'), 400)
  }

  const db = env.HOBBOT_DB
  const subscriber = await db.prepare('SELECT id, status FROM subscribers WHERE token = ?').bind(token).first<{
    id: number
    status: string
  }>()

  if (!subscriber) {
    return htmlResponse(styledPage('Not Found', 'Link Not Found', 'This confirmation link is invalid or has expired.'), 404)
  }

  if (subscriber.status === 'confirmed') {
    return htmlResponse(styledPage('Already Confirmed', 'Already Confirmed', "You're already subscribed to HobFarm updates. No further action needed."))
  }

  await db.prepare(
    `UPDATE subscribers SET status = 'confirmed', confirmed_at = datetime('now') WHERE id = ?`
  ).bind(subscriber.id).run()

  return htmlResponse(styledPage(
    'Subscription Confirmed',
    'You\'re In',
    'Your subscription is confirmed. You\'ll receive updates on HobFarm projects and the Atomic Noir universe.',
    'Visit HobFarm',
    'https://hob.farm'
  ))
}

export async function handleUnsubscribeRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const token = url.searchParams.get('token')

  if (!token) {
    return htmlResponse(styledPage('Error', 'Invalid Link', 'This unsubscribe link is invalid.'), 400)
  }

  const db = env.HOBBOT_DB
  const subscriber = await db.prepare('SELECT id, status FROM subscribers WHERE token = ?').bind(token).first<{
    id: number
    status: string
  }>()

  if (!subscriber) {
    return htmlResponse(styledPage('Not Found', 'Link Not Found', 'This unsubscribe link is invalid.'), 404)
  }

  if (subscriber.status === 'unsubscribed') {
    return htmlResponse(styledPage('Already Unsubscribed', 'Already Unsubscribed', "You've already been unsubscribed. You won't receive any more emails."))
  }

  await db.prepare(
    `UPDATE subscribers SET status = 'unsubscribed', unsubscribed_at = datetime('now') WHERE id = ?`
  ).bind(subscriber.id).run()

  return htmlResponse(styledPage(
    'Unsubscribed',
    'Unsubscribed',
    "You've been unsubscribed from HobFarm updates. We're sorry to see you go.",
    'Visit HobFarm',
    'https://hob.farm'
  ))
}
