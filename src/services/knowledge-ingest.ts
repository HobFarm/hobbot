// Knowledge Ingest Pipeline: fetch URL, extract via Gemini, insert atoms + relations

import { GeminiProvider } from '../providers/gemini'
import { ingestAtom } from '../grimoire/ingest'
import { createGrimoireHandle } from '../grimoire/handle'
import { AESTHETIC_EXTRACTION_PROMPT, DOMAIN_EXTRACTION_PROMPT } from '../prompts/extraction'
import type {
  KnowledgeIngestRequest, KnowledgeIngestResult, IngestLog,
  AestheticExtraction, DomainExtraction, AtomRelationType,
} from '../grimoire/types'

// Minimal env interface: only what ingest needs (avoids full Env import issues across workers)
interface IngestEnv {
  GRIMOIRE_DB: D1Database
  GEMINI_API_KEY: string
}

// ---- HTML Fetching + Cleaning ----

async function fetchAndCleanHtml(url: string): Promise<string> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 15_000)

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'HobBot-Grimoire/1.0 (knowledge-ingest)' },
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }
    const html = await response.text()
    return stripHtmlToText(html)
  } finally {
    clearTimeout(timeoutId)
  }
}

function stripHtmlToText(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<\/?(div|p|br|h[1-6]|li|tr|td|th|blockquote|article|section)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim()

  // Truncate to stay within Gemini context limits while leaving room for prompt
  if (text.length > 12000) {
    text = text.slice(0, 12000) + '\n[...truncated]'
  }

  return text
}

// ---- Extraction via Gemini ----

function sanitizeGeminiJson(raw: string): string {
  let cleaned = raw.trim()
  // Strip markdown fences
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
  }
  return cleaned
}

async function extractKnowledge(
  pageText: string,
  sourceType: 'aesthetic' | 'domain',
  geminiApiKey: string
): Promise<AestheticExtraction | DomainExtraction> {
  const provider = new GeminiProvider('gemini-2.5-flash', geminiApiKey)
  const prompt = sourceType === 'aesthetic'
    ? AESTHETIC_EXTRACTION_PROMPT
    : DOMAIN_EXTRACTION_PROMPT

  const response = await provider.generateResponse({
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: `Extract knowledge from this page content:\n\n${pageText}` },
    ],
    temperature: 0.2,
    maxTokens: 8192,
    responseFormat: 'json',
  })

  const cleaned = sanitizeGeminiJson(response.content)
  const parsed = JSON.parse(cleaned)

  console.log(`[ingest:extract] type=${sourceType} cost=$${response.usage.estimatedCost.toFixed(4)} tokens=${response.usage.inputTokens}+${response.usage.outputTokens}`)

  return parsed
}

// ---- Atom Collection from Extraction ----

function collectAtomTexts(extraction: AestheticExtraction | DomainExtraction, sourceType: 'aesthetic' | 'domain'): string[] {
  const texts: string[] = []

  if ('visual_atoms' in extraction) texts.push(...extraction.visual_atoms)
  if ('atmospheric_phrases' in extraction) texts.push(...extraction.atmospheric_phrases)

  if (sourceType === 'aesthetic') {
    const ae = extraction as AestheticExtraction
    if (ae.color_atoms) texts.push(...ae.color_atoms)
    if (ae.material_atoms) texts.push(...ae.material_atoms)
    // Include the aesthetic name itself as an atom
    if (ae.aesthetic_name) texts.push(ae.aesthetic_name)
  } else {
    const de = extraction as DomainExtraction
    if (de.conceptual_atoms) texts.push(...de.conceptual_atoms)
    if (de.style_references) texts.push(...de.style_references)
    // proper_nouns are reference anchors, include them too
    if (de.proper_nouns) texts.push(...de.proper_nouns)
  }

  // Deduplicate and filter
  const seen = new Set<string>()
  return texts
    .map(t => t?.trim())
    .filter((t): t is string => !!t && t.length >= 3 && !seen.has(t.toLowerCase()) && (seen.add(t.toLowerCase()), true))
}

// ---- Relation Type Mapping ----

function mapRelationType(wikiRelation: string): { type: AtomRelationType; swap: boolean } {
  switch (wikiRelation) {
    case 'parent':
      // This aesthetic evolved FROM the parent, so: this derives_from parent
      return { type: 'derives_from', swap: false }
    case 'child':
      // The child evolved FROM this aesthetic, so: child derives_from this (swap direction)
      return { type: 'derives_from', swap: true }
    case 'influence':
      return { type: 'derives_from', swap: false }
    case 'sibling':
      return { type: 'co_occurs', swap: false }
    case 'opposite':
      return { type: 'oppositional', swap: false }
    default:
      return { type: 'co_occurs', swap: false }
  }
}

// ---- Main Pipeline ----

export async function ingestKnowledge(
  env: IngestEnv,
  request: KnowledgeIngestRequest
): Promise<KnowledgeIngestResult> {
  const db = env.GRIMOIRE_DB
  const handle = createGrimoireHandle(db)
  const collectionSlug = request.collection_slug ?? 'uncategorized'
  const dryRun = request.dry_run ?? false

  // Check for existing completed ingest of this URL
  const existing = await handle.ingestLogByUrl(request.url)
  if (existing && existing.status === 'complete' && !dryRun) {
    return {
      ingest_log: existing,
      atoms_created: [],
      atoms_skipped: [],
      relations_created: [],
      dry_run: false,
    }
  }

  // Create log entry
  const logId = crypto.randomUUID()
  if (!dryRun) {
    await handle.ingestLogInsert({
      id: logId,
      url: request.url,
      source_type: request.source_type,
      status: 'processing',
      atoms_created: 0,
      atoms_skipped: 0,
      relations_created: 0,
      extraction_json: null,
      error_message: null,
      dry_run: false,
    })
  }

  try {
    // Fetch and clean HTML
    const pageText = await fetchAndCleanHtml(request.url)
    console.log(`[ingest:fetch] url=${request.url} chars=${pageText.length}`)

    // Extract via Gemini
    const extraction = await extractKnowledge(pageText, request.source_type, env.GEMINI_API_KEY)

    // Collect atom texts from extraction
    const atomTexts = collectAtomTexts(extraction, request.source_type)
    console.log(`[ingest:atoms] extracted=${atomTexts.length} source_type=${request.source_type}`)

    const atomsCreated: string[] = []
    const atomsSkipped: string[] = []

    if (!dryRun) {
      // Insert atoms through the existing pipeline
      for (const text of atomTexts) {
        const result = await ingestAtom(db, {
          text,
          collection_slug: collectionSlug,
          source: 'ai',
          source_app: 'knowledge-ingest',
          observation: 'observation',
          confidence: 0.6,
          metadata: { source_url: request.url },
        })

        if (result.atom) {
          atomsCreated.push(result.atom.id)
        } else {
          atomsSkipped.push(text)
        }
      }
    } else {
      // Dry run: check what would be created vs skipped
      for (const text of atomTexts) {
        const existing = await handle.lookup(text)
        if (existing) {
          atomsSkipped.push(text)
        } else {
          atomsCreated.push(text)
        }
      }
    }

    // Create relations (aesthetic sources only, not dry run)
    const relationsCreated: string[] = []

    if (request.source_type === 'aesthetic' && !dryRun) {
      const ae = extraction as AestheticExtraction
      if (ae.related_aesthetics?.length && ae.aesthetic_name) {
        // Find the primary aesthetic atom we just created (or that already existed)
        const primaryAtom = await handle.lookup(ae.aesthetic_name)

        if (primaryAtom) {
          for (const rel of ae.related_aesthetics) {
            const relatedAtom = await handle.lookup(rel.name)
            if (!relatedAtom) continue

            const { type, swap } = mapRelationType(rel.relation)
            const sourceId = swap ? relatedAtom.id : primaryAtom.id
            const targetId = swap ? primaryAtom.id : relatedAtom.id

            try {
              const result = await handle.addRelation({
                source_atom_id: sourceId,
                target_atom_id: targetId,
                relation_type: type,
                strength: 0.7,
                context: 'knowledge-ingest',
                source: 'inferred',
                confidence: 0.8,
              })
              relationsCreated.push(result.id)
            } catch (err) {
              console.warn(`[ingest:relation] failed: ${ae.aesthetic_name} -> ${rel.name}: ${(err as Error).message}`)
            }
          }
        }
      }
    }

    // Update log entry
    const now = new Date().toISOString()
    const finalLog: IngestLog = {
      id: logId,
      url: request.url,
      source_type: request.source_type,
      status: dryRun ? 'complete' : 'complete',
      atoms_created: atomsCreated.length,
      atoms_skipped: atomsSkipped.length,
      relations_created: relationsCreated.length,
      extraction_json: extraction as unknown as Record<string, unknown>,
      error_message: null,
      dry_run: dryRun,
      created_at: now,
      completed_at: now,
    }

    if (!dryRun) {
      await handle.ingestLogUpdate(logId, {
        status: 'complete',
        atoms_created: atomsCreated.length,
        atoms_skipped: atomsSkipped.length,
        relations_created: relationsCreated.length,
        extraction_json: extraction as unknown as Record<string, unknown>,
        completed_at: now,
      })
    }

    console.log(`[ingest:done] url=${request.url} created=${atomsCreated.length} skipped=${atomsSkipped.length} relations=${relationsCreated.length} dry_run=${dryRun}`)

    return {
      ingest_log: finalLog,
      atoms_created: atomsCreated,
      atoms_skipped: atomsSkipped,
      relations_created: relationsCreated,
      dry_run: dryRun,
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.error(`[ingest:error] url=${request.url} error=${errorMsg}`)

    if (!dryRun) {
      await handle.ingestLogUpdate(logId, {
        status: 'failed',
        error_message: errorMsg,
        completed_at: new Date().toISOString(),
      })
    }

    throw error
  }
}
