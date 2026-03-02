// Immune system: AI-powered validation for ambiguous cases
// Called by ingest.ts when structural validation passes but deeper checks are needed

import { getProvider } from '../providers/index'
import { PROVIDER } from '../config'
import type { GrimoireAtom, ValidationResult } from './types'

interface DuplicateCheckResult {
  isDuplicate: boolean
  confidence: number
  matchingText?: string
}

// Check if two atoms are semantically duplicate using AI judgment
// Only called when text_lower is different but text is very similar
export async function aiDuplicateCheck(
  apiKey: string,
  candidate: Partial<GrimoireAtom>,
  existing: GrimoireAtom
): Promise<DuplicateCheckResult> {
  const provider = getProvider(PROVIDER.VALIDATION, PROVIDER.DEFAULT_MODEL, apiKey)

  const prompt = `Are these two grimoire entries semantically equivalent?

Entry A: "${candidate.text}"
Entry B: "${existing.text}"

Both are in collection: ${existing.collection_slug}

Respond with JSON: { "duplicate": boolean, "confidence": 0-1, "reason": "brief explanation" }`

  try {
    const response = await provider.generateResponse({
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      maxTokens: 200,
      responseFormat: 'json',
    })

    const parsed = JSON.parse(response.content) as { duplicate: boolean; confidence: number }
    return {
      isDuplicate: parsed.duplicate,
      confidence: parsed.confidence ?? 0.5,
      matchingText: existing.text,
    }
  } catch {
    // AI check failed; fall back to non-duplicate
    return { isDuplicate: false, confidence: 0 }
  }
}

// Merge AI findings into ValidationResult
export function applyAiFindings(
  base: ValidationResult,
  duplicate: DuplicateCheckResult
): ValidationResult {
  if (!duplicate.isDuplicate || duplicate.confidence < 0.8) return base

  return {
    ...base,
    valid: false,
    errors: [
      ...base.errors,
      {
        field: 'text',
        message: `semantic duplicate of '${duplicate.matchingText}' (AI confidence: ${(duplicate.confidence * 100).toFixed(0)}%)`,
        rule: 'ai_duplicate',
      },
    ],
  }
}
