// Shared Internet Archive API client.
// Used by gateway MCP tools (admin_archive_*) and the custodian's archive-org agent.
// Handles User-Agent, ≥1s rate limiting between requests within an isolate,
// and exponential backoff on 429/503.

const USER_AGENT = 'HobBot/1.0 (https://hob.farm; hobfarm content ingestion)'
const MIN_INTERVAL_MS = 1000
const BACKOFF_BASE_MS = 2000
const BACKOFF_MAX_MS = 60_000
const DEFAULT_TIMEOUT_MS = 15_000

let lastRequestAt = 0

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

export class IATimeoutError extends Error {
  constructor(public url: string, public timeoutMs: number) {
    super(`Archive.org request timed out after ${timeoutMs}ms`)
    this.name = 'IATimeoutError'
  }
}

export async function fetchIA(url: string, opts: { maxRetries?: number; timeoutMs?: number } = {}): Promise<Response> {
  const maxRetries = opts.maxRetries ?? 3
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  // Throttle: ≥1s between calls within this isolate
  const since = Date.now() - lastRequestAt
  if (since < MIN_INTERVAL_MS) await sleep(MIN_INTERVAL_MS - since)
  lastRequestAt = Date.now()

  let delay = BACKOFF_BASE_MS
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: controller.signal,
      })
      if (response.ok) return response
      if ((response.status === 429 || response.status === 503) && attempt < maxRetries) {
        await sleep(delay)
        delay = Math.min(delay * 2, BACKOFF_MAX_MS)
        lastRequestAt = Date.now()
        continue
      }
      return response
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        throw new IATimeoutError(url, timeoutMs)
      }
      throw e
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error('unreachable')
}

// ─── Search ──────────────────────────────────────────────────────────

export interface SearchParams {
  query: string
  collection?: string
  mediatype?: string
  language?: string
  sort?: string
  limit?: number
}

export interface IASearchHit {
  identifier: string
  title?: string
  description?: string
  creator?: string
  date?: string
  downloads?: number
  collection?: string[]
  language?: string
  mediatype?: string
}

export interface SearchResult {
  hits: IASearchHit[]
  totalResults: number
}

export async function searchItems(params: SearchParams): Promise<SearchResult> {
  const parts: string[] = [params.query]
  if (params.collection) parts.unshift(`collection:${params.collection}`)
  if (params.mediatype) parts.push(`mediatype:${params.mediatype}`)
  if (params.language) parts.push(`language:${params.language}`)
  const q = parts.filter(Boolean).join(' AND ')

  const limit = Math.min(Math.max(params.limit ?? 10, 1), 50)
  const search = new URLSearchParams({
    q,
    fl: 'identifier,title,description,creator,date,downloads,collection,language,mediatype',
    output: 'json',
    rows: String(limit),
  })
  if (params.sort) search.set('sort', params.sort)

  const response = await fetchIA(`https://archive.org/advancedsearch.php?${search}`)
  if (!response.ok) {
    throw new Error(`IA search failed: ${response.status} ${response.statusText}`)
  }
  const data = await response.json() as { response?: { docs?: IASearchHit[]; numFound?: number } }
  return {
    hits: data.response?.docs ?? [],
    totalResults: data.response?.numFound ?? 0,
  }
}

// ─── Item metadata ───────────────────────────────────────────────────

export interface IAFile {
  name: string
  format?: string
  size?: string
}

export interface ItemMetadata {
  identifier: string
  title?: string
  description?: string
  creator?: string
  date?: string
  subject?: string[]
  collections?: string[]
  language?: string
  ocrEngine?: string
  ocrAvailable: boolean
  files: IAFile[]
  raw: Record<string, unknown>
}

function asArray(v: unknown): string[] | undefined {
  if (v == null) return undefined
  if (Array.isArray(v)) return v.map(String)
  return [String(v)]
}

export async function getItemMetadata(identifier: string): Promise<ItemMetadata> {
  const response = await fetchIA(`https://archive.org/metadata/${identifier}`)
  if (!response.ok) throw new Error(`IA metadata failed: ${response.status}`)
  const data = await response.json() as {
    metadata?: Record<string, unknown>
    files?: IAFile[]
  }
  const md = data.metadata ?? {}
  const files = data.files ?? []
  const ocrAvailable = Boolean(
    md.ocr || files.some(f => f.name.includes('_djvu.txt') || f.name.includes('_ocr_search.txt'))
  )
  return {
    identifier,
    title: md.title as string | undefined,
    description: md.description as string | undefined,
    creator: md.creator as string | undefined,
    date: md.date as string | undefined,
    subject: asArray(md.subject),
    collections: asArray(md.collection),
    language: md.language as string | undefined,
    ocrEngine: md.ocr as string | undefined,
    ocrAvailable,
    files,
    raw: md,
  }
}

// ─── Views API ───────────────────────────────────────────────────────

export interface ItemViews {
  allTime: number
  last30Days: number | null
}

export async function getItemViews(identifier: string): Promise<ItemViews | null> {
  try {
    const response = await fetchIA(`https://be-api.us.archive.org/views/v1/short/${identifier}`)
    if (!response.ok) return null
    const data = await response.json() as {
      non_robot?: { all_time?: number; previous_days_counts?: number[] }
    }
    const allTime = data.non_robot?.all_time ?? 0
    const recent = data.non_robot?.previous_days_counts ?? []
    const last30 = recent.length > 0 ? recent.slice(0, 30).reduce((a, b) => a + b, 0) : null
    return { allTime, last30Days: last30 }
  } catch {
    return null
  }
}

// ─── Text preview ────────────────────────────────────────────────────

export interface TextPreview {
  text: string
  totalLength: number
  ocrQuality: 'good' | 'poor'
  source: 'djvu' | 'ocr_search' | null
}

function assessOcrQuality(text: string): 'good' | 'poor' {
  if (text.length === 0) return 'poor'
  const sample = text.slice(0, 2000)
  let garbage = 0
  for (const ch of sample) {
    const code = ch.charCodeAt(0)
    const isAscii = code < 128
    const isPunct = /[\s.,;:!?'"()\-\u2014\u2013]/.test(ch)
    if (!isAscii && !isPunct) garbage++
  }
  return garbage / sample.length > 0.1 ? 'poor' : 'good'
}

export async function fetchTextPreview(identifier: string, maxChars = 3000): Promise<TextPreview> {
  const limit = Math.min(Math.max(maxChars, 1), 10000)
  for (const variant of [`${identifier}_djvu.txt`, `${identifier}_ocr_search.txt`] as const) {
    const url = `https://archive.org/download/${identifier}/${variant}`
    const response = await fetchIA(url)
    if (!response.ok) continue
    const text = await response.text()
    if (!text) continue
    return {
      text: text.slice(0, limit),
      totalLength: text.length,
      ocrQuality: assessOcrQuality(text),
      source: variant.endsWith('_djvu.txt') ? 'djvu' : 'ocr_search',
    }
  }
  return { text: '', totalLength: 0, ocrQuality: 'poor', source: null }
}

// ─── PDF selection ───────────────────────────────────────────────────

export interface PickedPdf {
  filename: string
  format: string
  size?: string
  sizeMB: number
  downloadUrl: (identifier: string) => string
}

export function pickBestPdf(files: IAFile[]): PickedPdf | null {
  const isPdf = (f: IAFile) => f.name.toLowerCase().endsWith('.pdf')
  const byFormat = (label: string) => files.find(f => isPdf(f) && f.format === label)

  // Priority order
  let pick: IAFile | undefined =
    byFormat('Text PDF') ||
    byFormat('Additional Text PDF')

  if (!pick) {
    const pdfs = files.filter(isPdf)
    // Skip *_text.pdf if a regular PDF exists
    const regular = pdfs.find(f => !/_text\.pdf$/i.test(f.name))
    pick = regular ?? pdfs[0]
  }

  if (!pick) {
    // EPUB fallback
    const epub = files.find(f => f.name.toLowerCase().endsWith('.epub'))
    if (!epub) return null
    pick = epub
  }

  const sizeBytes = parseInt(pick.size ?? '0') || 0
  return {
    filename: pick.name,
    format: pick.format ?? 'unknown',
    size: pick.size,
    sizeMB: sizeBytes / (1024 * 1024),
    downloadUrl: (identifier: string) =>
      `https://archive.org/download/${identifier}/${encodeURIComponent(pick!.name)}`,
  }
}

export function buildDownloadUrl(identifier: string, filename: string): string {
  return `https://archive.org/download/${identifier}/${encodeURIComponent(filename)}`
}
