// Shared AI call utility: JSON output with retry, fallback, circuit breaker, timeout.
// Used by hobbot-custodian (conductor, archive-org) and hobbot-pipeline (enrichment, vocabulary, indexing, correspondence).

import { WorkersAIProvider } from './workers-ai'
import type { ModelEntry, TaskConfig } from '../models'
import type { AIUsage } from './types'

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
  timeoutMs?: number
  onUsage?: (usage: TokenUsageReport) => void | Promise<void>
}

async function reportUsage(
  options: CallOptions | undefined,
  taskType: string,
  model: string,
  provider: string,
  usage: AIUsage,
): Promise<void> {
  if (!options?.onUsage) return
  try {
    await options.onUsage({
      taskType,
      model,
      provider,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      estimatedCost: usage.estimatedCost,
    })
  } catch (err) {
    console.warn(`[callWithJsonParse] usage logging failed for ${taskType}/${model}: ${err instanceof Error ? err.message : String(err)}`)
  }
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
const MAX_FAILURE_DETAIL_CHARS = 180

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ])
}

function formatAttemptFailure(label: string, reason: unknown): string {
  const msg = reason instanceof Error ? reason.message : String(reason)
  return `${label}:${msg.replace(/\s+/g, ' ').slice(0, MAX_FAILURE_DETAIL_CHARS)}`
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

function removeTrailingCommas(text: string): string {
  return text.replace(/,\s*([}\]])/g, '$1')
}

function parseJsonCandidate(text: string): unknown {
  const stripped = stripFences(text.trim().replace(/^\uFEFF/, ''))
  const candidates = [stripped]
  const repaired = removeTrailingCommas(stripped)
  if (repaired !== stripped) candidates.push(repaired)

  for (const candidate of candidates) {
    try { return JSON.parse(candidate) } catch {}
  }
  return null
}

function parseBalancedJson(text: string, openChar: '{' | '['): unknown {
  const closeChar = openChar === '{' ? '}' : ']'

  for (let start = text.indexOf(openChar); start >= 0; start = text.indexOf(openChar, start + 1)) {
    let depth = 0
    let inString = false
    let escaped = false

    for (let i = start; i < text.length; i++) {
      const ch = text[i]

      if (inString) {
        if (escaped) {
          escaped = false
        } else if (ch === '\\') {
          escaped = true
        } else if (ch === '"') {
          inString = false
        }
        continue
      }

      if (ch === '"') {
        inString = true
        continue
      }
      if (ch === openChar) {
        depth++
      } else if (ch === closeChar) {
        depth--
        if (depth === 0) {
          const parsed = parseJsonCandidate(text.slice(start, i + 1))
          if (parsed !== null) return parsed
          break
        }
      }
    }
  }

  return null
}

export function extractJson(text: string): unknown {
  const cleaned = stripThinkBlocks(text).trim()
  const direct = parseJsonCandidate(cleaned)
  if (direct !== null) return direct

  const object = parseBalancedJson(cleaned, '{')
  if (object !== null) return object

  const array = parseBalancedJson(cleaned, '[')
  if (array !== null) return array

  return null
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
 */
export async function callWithJsonParse<T>(
  taskType: string,
  systemPrompt: string,
  userContent: string,
  ai: Ai,
  _externalProviderKey: string,
  modelConfig: TaskConfig,
  options?: CallOptions,
): Promise<{ result: T; modelUsed: string }> {
  const primary = modelConfig.primary
  const providerKey = `${primary.provider}:${primary.model}`
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const attemptFailures: string[] = []

  // Circuit breaker check on primary
  if (options?.health) {
    const healthy = await isHealthy(options.health, providerKey)
    if (!healthy) {
      console.log(`[callWithJsonParse] Skipping ${providerKey} (circuit open), going to fallbacks`)
      attemptFailures.push(formatAttemptFailure(`${providerKey}:primary`, 'circuit breaker open'))
      return attemptFallbacks(taskType, modelConfig.fallbacks, systemPrompt, userContent, ai, options, attemptFailures)
    }
  }

  // Attempt 1: primary model with timeout
  try {
    if (primary.provider !== 'workers-ai') {
      throw new Error(`Unsupported provider for ${taskType}: ${primary.provider}`)
    }
    const provider = new WorkersAIProvider(primary.model, ai)

    const request = {
      messages: [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user' as const, content: userContent },
      ],
      temperature: primary.options?.temperature ?? 0.2,
      maxTokens: primary.options?.maxOutputTokens ?? 1024,
      ...(typeof primary.options?.thinkingBudget === 'number' ? { thinkingBudget: primary.options.thinkingBudget } : {}),
      responseFormat: primary.options?.responseFormat,
    }

    const resp1 = await withTimeout(provider.generateResponse(request), timeoutMs, `${taskType}:primary`)
    await reportUsage(options, taskType, primary.model, primary.provider, resp1.usage)
    const parsed1 = extractJson(resp1.content)
    if (parsed1 !== null) {
      if (options?.health) await recordSuccess(options.health, providerKey)
      return { result: parsed1 as T, modelUsed: primary.model }
    }
    attemptFailures.push(formatAttemptFailure(
      `${providerKey}:primary`,
      `json_parse:no_valid_json response_chars=${resp1.content.length}`,
    ))

    // Attempt 2: retry with stricter instruction
    const retryRequest = {
      ...request,
      messages: [
        { role: 'system' as const, content: systemPrompt + '\n\nCRITICAL: Your previous response was not valid JSON. Output ONLY the JSON object. No text before or after.' },
        { role: 'user' as const, content: userContent },
      ],
    }
    const resp2 = await withTimeout(provider.generateResponse(retryRequest), timeoutMs, `${taskType}:retry`)
    await reportUsage(options, taskType, primary.model, primary.provider, resp2.usage)
    const parsed2 = extractJson(resp2.content)
    if (parsed2 !== null) {
      if (options?.health) await recordSuccess(options.health, providerKey)
      return { result: parsed2 as T, modelUsed: primary.model + ':retry' }
    }
    attemptFailures.push(formatAttemptFailure(
      `${providerKey}:retry`,
      `json_parse:no_valid_json response_chars=${resp2.content.length}`,
    ))
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    attemptFailures.push(formatAttemptFailure(`${providerKey}:primary_or_retry`, msg))
    console.warn(`[callWithJsonParse] primary failed for ${taskType}: ${msg}`)
    if (options?.health) await recordFailure(options.health, providerKey)
  }

  // Attempt 3: fallbacks
  return attemptFallbacks(taskType, modelConfig.fallbacks, systemPrompt, userContent, ai, options, attemptFailures)
}

async function attemptFallbacks<T>(
  taskType: string,
  fallbacks: ModelEntry[],
  systemPrompt: string,
  userContent: string,
  ai: Ai,
  options?: CallOptions,
  attemptFailures: string[] = [],
): Promise<{ result: T; modelUsed: string }> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS

  for (const fb of fallbacks) {
    const fbKey = `${fb.provider}:${fb.model}`

    if (options?.health) {
      const healthy = await isHealthy(options.health, fbKey)
      if (!healthy) {
        console.log(`[callWithJsonParse] Skipping fallback ${fbKey} (circuit open)`)
        attemptFailures.push(formatAttemptFailure(`${fbKey}:fallback`, 'circuit breaker open'))
        continue
      }
    }

    try {
      let text: string
      if (fb.provider !== 'workers-ai') {
        attemptFailures.push(formatAttemptFailure(`${fbKey}:fallback`, `unsupported_provider:${fb.provider}`))
        continue
      }
      const provider = new WorkersAIProvider(fb.model, ai)
      const fbResp = await withTimeout(provider.generateResponse({
        messages: [
          { role: 'system' as const, content: systemPrompt },
          { role: 'user' as const, content: userContent },
        ],
        temperature: fb.options?.temperature ?? 0.2,
        maxTokens: fb.options?.maxOutputTokens ?? 1024,
        ...(typeof fb.options?.thinkingBudget === 'number' ? { thinkingBudget: fb.options.thinkingBudget } : {}),
        responseFormat: fb.options?.responseFormat,
      }), timeoutMs, `${taskType}:fallback:${fb.model}`)
      text = fbResp.content
      await reportUsage(options, taskType, fb.model, fb.provider, fbResp.usage)

      const parsed = extractJson(text)
      if (parsed !== null) {
        if (options?.health) await recordSuccess(options.health, fbKey)
        return { result: parsed as T, modelUsed: fb.model + ':fallback' }
      }
      attemptFailures.push(formatAttemptFailure(
        `${fbKey}:fallback`,
        `json_parse:no_valid_json response_chars=${text.length}`,
      ))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      attemptFailures.push(formatAttemptFailure(`${fbKey}:fallback`, msg))
      console.warn(`[callWithJsonParse] fallback ${fb.model} failed for ${taskType}: ${msg}`)
      if (options?.health) await recordFailure(options.health, fbKey)
    }
  }

  const detail = attemptFailures.length ? ` Details: ${attemptFailures.join(' | ')}` : ''
  throw new Error(`[callWithJsonParse] All attempts failed for ${taskType}.${detail}`)
}
