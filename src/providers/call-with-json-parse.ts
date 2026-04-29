// Shared AI call utility: JSON output with retry, fallback, circuit breaker, timeout.
// Used by hobbot-custodian (conductor, archive-org) and hobbot-pipeline (enrichment, vocabulary, indexing, correspondence).

import { GeminiProvider } from './gemini'
import { WorkersAIProvider } from './workers-ai'
import type { ModelEntry, TaskConfig } from '../models'

// --- Types ---

export interface GatewayConfig {
  accountId: string
  name: string
  token: string
}

export interface TokenUsageReport {
  taskType: string
  model: string
  provider: string
  inputTokens: number
  outputTokens: number
  estimatedCost: number
}

export interface CallOptions {
  health?: KVNamespace
  gateway?: GatewayConfig
  timeoutMs?: number
  onUsage?: (usage: TokenUsageReport) => void
}

// --- Circuit breaker (inline, avoids importing from worker-specific modules) ---

async function isHealthy(kv: KVNamespace, providerKey: string): Promise<boolean> {
  const raw = await kv.get(`provider:health:${providerKey}`)
  if (!raw) return true
  const health = JSON.parse(raw) as { failures: number; lastFailure: number }
  if (Date.now() - health.lastFailure > 5 * 60 * 1000) return true
  return health.failures < 3
}

async function recordFailure(kv: KVNamespace, providerKey: string): Promise<void> {
  const raw = await kv.get(`provider:health:${providerKey}`)
  const now = Date.now()
  let health: { failures: number; lastFailure: number }
  if (raw) {
    health = JSON.parse(raw)
    if (now - health.lastFailure > 5 * 60 * 1000) {
      health = { failures: 1, lastFailure: now }
    } else {
      health.failures++
      health.lastFailure = now
    }
  } else {
    health = { failures: 1, lastFailure: now }
  }
  const ttl = health.failures >= 3 ? 900 : 600
  await kv.put(`provider:health:${providerKey}`, JSON.stringify(health), { expirationTtl: ttl })
}

async function recordSuccess(kv: KVNamespace, providerKey: string): Promise<void> {
  await kv.delete(`provider:health:${providerKey}`)
}

// --- Timeout ---

const DEFAULT_TIMEOUT_MS = 30_000

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ])
}

// --- JSON extraction ---

function stripFences(text: string): string {
  let cleaned = text.trim()
  if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7)
  else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3)
  if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3)
  return cleaned.trim()
}

function stripThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
}

export function extractJson(text: string): unknown {
  const cleaned = stripThinkBlocks(text)
  try { return JSON.parse(cleaned) } catch {}
  const stripped = stripFences(cleaned)
  try { return JSON.parse(stripped) } catch {}
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)) } catch {}
  }
  // Try array
  const arrStart = cleaned.indexOf('[')
  const arrEnd = cleaned.lastIndexOf(']')
  if (arrStart >= 0 && arrEnd > arrStart) {
    try { return JSON.parse(cleaned.slice(arrStart, arrEnd + 1)) } catch {}
  }
  return null
}

// --- Gemini via AI Gateway ---

async function fetchGeminiViaGateway(
  model: string,
  geminiKey: string,
  systemPrompt: string,
  userContent: string,
  options: { temperature?: number; maxOutputTokens?: number },
  gateway?: GatewayConfig,
): Promise<string> {
  const directUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`
  const gatewayUrl = gateway
    ? `https://gateway.ai.cloudflare.com/v1/${gateway.accountId}/${gateway.name}/google-ai-studio/v1beta/models/${model}:generateContent?key=${geminiKey}`
    : null

  const body = JSON.stringify({
    contents: [{ parts: [{ text: `${systemPrompt}\n\n${userContent}` }] }],
    generationConfig: {
      temperature: options.temperature ?? 0.2,
      maxOutputTokens: options.maxOutputTokens ?? 1024,
      responseMimeType: 'application/json',
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    ],
  })

  const url = gatewayUrl ?? directUrl
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (gatewayUrl && gateway) {
    headers['cf-aig-authorization'] = `Bearer ${gateway.token}`
  }

  let response = await fetch(url, { method: 'POST', headers, body })

  if (response.status === 401 && gatewayUrl) {
    console.log(`[callWithJsonParse] Gemini gateway 401, falling back to direct API`)
    response = await fetch(directUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
  }

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`Gemini ${response.status}: ${errText.slice(0, 500)}`)
  }

  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
  }
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error('Empty response from Gemini')
  return text
}

// --- Main export ---

/**
 * Call an AI model and parse JSON output with retry + fallback.
 *
 * Strategy:
 * 1. Call primary model, try to parse JSON from response
 * 2. If parse fails, retry with stricter prompt suffix
 * 3. If retry fails, loop through all configured fallbacks
 *
 * Optional features (via CallOptions):
 * - Circuit breaker: skip providers that have failed 3+ times in 5 min
 * - Timeout: abort calls that exceed timeoutMs (default 30s)
 * - AI Gateway: route Gemini fallback through Cloudflare AI Gateway
 */
export async function callWithJsonParse<T>(
  taskType: string,
  systemPrompt: string,
  userContent: string,
  ai: Ai,
  geminiKey: string,
  modelConfig: TaskConfig,
  options?: CallOptions,
): Promise<{ result: T; modelUsed: string }> {
  const primary = modelConfig.primary
  const providerKey = `${primary.provider}:${primary.model}`
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS

  // Circuit breaker check on primary
  if (options?.health) {
    const healthy = await isHealthy(options.health, providerKey)
    if (!healthy) {
      console.log(`[callWithJsonParse] Skipping ${providerKey} (circuit open), going to fallbacks`)
      return attemptFallbacks(taskType, modelConfig.fallbacks, systemPrompt, userContent, ai, geminiKey, options)
    }
  }

  // Attempt 1: primary model with timeout
  try {
    const provider = primary.provider === 'workers-ai'
      ? new WorkersAIProvider(primary.model, ai)
      : new GeminiProvider(primary.model, geminiKey)

    const request = {
      messages: [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user' as const, content: userContent },
      ],
      temperature: primary.options?.temperature ?? 0.2,
      maxTokens: primary.options?.maxOutputTokens ?? 1024,
      ...(primary.provider === 'gemini' ? { responseFormat: 'json' as const } : {}),
    }

    const resp1 = await withTimeout(provider.generateResponse(request), timeoutMs, `${taskType}:primary`)
    const parsed1 = extractJson(resp1.content)
    if (parsed1 !== null) {
      if (options?.health) await recordSuccess(options.health, providerKey)
      if (options?.onUsage) try { options.onUsage({ taskType, model: primary.model, provider: primary.provider, inputTokens: resp1.usage.inputTokens, outputTokens: resp1.usage.outputTokens, estimatedCost: resp1.usage.estimatedCost }) } catch {}
      return { result: parsed1 as T, modelUsed: primary.model }
    }

    // Attempt 2: retry with stricter instruction
    const retryRequest = {
      ...request,
      messages: [
        { role: 'system' as const, content: systemPrompt + '\n\nCRITICAL: Your previous response was not valid JSON. Output ONLY the JSON object. No text before or after.' },
        { role: 'user' as const, content: userContent },
      ],
    }
    const resp2 = await withTimeout(provider.generateResponse(retryRequest), timeoutMs, `${taskType}:retry`)
    const parsed2 = extractJson(resp2.content)
    if (parsed2 !== null) {
      if (options?.health) await recordSuccess(options.health, providerKey)
      if (options?.onUsage) try { options.onUsage({ taskType, model: primary.model, provider: primary.provider, inputTokens: resp2.usage.inputTokens, outputTokens: resp2.usage.outputTokens, estimatedCost: resp2.usage.estimatedCost }) } catch {}
      return { result: parsed2 as T, modelUsed: primary.model + ':retry' }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.warn(`[callWithJsonParse] primary failed for ${taskType}: ${msg}`)
    if (options?.health) await recordFailure(options.health, providerKey)
  }

  // Attempt 3: fallbacks
  return attemptFallbacks(taskType, modelConfig.fallbacks, systemPrompt, userContent, ai, geminiKey, options)
}

async function attemptFallbacks<T>(
  taskType: string,
  fallbacks: ModelEntry[],
  systemPrompt: string,
  userContent: string,
  ai: Ai,
  geminiKey: string,
  options?: CallOptions,
): Promise<{ result: T; modelUsed: string }> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS

  for (const fb of fallbacks) {
    const fbKey = `${fb.provider}:${fb.model}`

    if (options?.health) {
      const healthy = await isHealthy(options.health, fbKey)
      if (!healthy) {
        console.log(`[callWithJsonParse] Skipping fallback ${fbKey} (circuit open)`)
        continue
      }
    }

    try {
      let text: string
      if (fb.provider === 'gemini') {
        text = await withTimeout(
          fetchGeminiViaGateway(fb.model, geminiKey, systemPrompt, userContent, {
            temperature: fb.options?.temperature,
            maxOutputTokens: fb.options?.maxOutputTokens,
          }, options?.gateway),
          timeoutMs,
          `${taskType}:fallback:${fb.model}`,
        )
      } else {
        const provider = new WorkersAIProvider(fb.model, ai)
        const fbResp = await withTimeout(provider.generateResponse({
          messages: [
            { role: 'system' as const, content: systemPrompt },
            { role: 'user' as const, content: userContent },
          ],
          temperature: fb.options?.temperature ?? 0.2,
          maxTokens: fb.options?.maxOutputTokens ?? 1024,
        }), timeoutMs, `${taskType}:fallback:${fb.model}`)
        text = fbResp.content
        // Fire usage callback for Workers AI fallback (Gemini fallback via gateway doesn't expose usage)
        if (options?.onUsage) try { options.onUsage({ taskType, model: fb.model, provider: fb.provider, inputTokens: fbResp.usage.inputTokens, outputTokens: fbResp.usage.outputTokens, estimatedCost: fbResp.usage.estimatedCost }) } catch {}
      }

      const parsed = extractJson(text)
      if (parsed !== null) {
        if (options?.health) await recordSuccess(options.health, fbKey)
        return { result: parsed as T, modelUsed: fb.model + ':fallback' }
      }
    } catch (e) {
      console.warn(`[callWithJsonParse] fallback ${fb.model} failed for ${taskType}: ${e instanceof Error ? e.message : e}`)
      if (options?.health) await recordFailure(options.health, fbKey)
    }
  }

  throw new Error(`[callWithJsonParse] All attempts failed for ${taskType}. No valid JSON produced.`)
}
