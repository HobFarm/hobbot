// Input normalization for new Grimoire entries
// Generates text_lower, sets defaults, parses JSON fields

import type { GrimoireAtom } from '../grimoire/types'

export function sanitizeAtom(raw: Partial<GrimoireAtom>): Partial<GrimoireAtom> {
  const out: Partial<GrimoireAtom> = { ...raw }

  if (out.text) {
    out.text = out.text.trim()
    out.text_lower = out.text.toLowerCase()
  }

  if (!out.status) out.status = 'provisional'
  if (!out.observation) out.observation = 'observation'
  if (!out.modality) out.modality = 'both'
  if (!out.source) out.source = 'manual'
  if (out.confidence === undefined) out.confidence = 0.5
  if (out.encounter_count === undefined) out.encounter_count = 1
  if (!out.embedding_status) out.embedding_status = 'pending'

  if (!Array.isArray(out.tags)) out.tags = safeParseArray(out.tags as unknown)
  if (!out.metadata || typeof out.metadata !== 'object') out.metadata = safeParseObject(out.metadata as unknown)
  if (!out.harmonics || typeof out.harmonics !== 'object') out.harmonics = safeParseObject(out.harmonics as unknown)

  const now = new Date().toISOString()
  if (!out.created_at) out.created_at = now
  if (!out.updated_at) out.updated_at = now

  return out
}

function safeParseArray(val: unknown): string[] {
  if (Array.isArray(val)) return val as string[]
  if (typeof val === 'string') {
    try { const p = JSON.parse(val); return Array.isArray(p) ? p : [] } catch { return [] }
  }
  return []
}

function safeParseObject(val: unknown): Record<string, unknown> {
  if (val && typeof val === 'object' && !Array.isArray(val)) return val as Record<string, unknown>
  if (typeof val === 'string') {
    try { const p = JSON.parse(val); return (p && typeof p === 'object') ? p : {} } catch { return {} }
  }
  return {}
}

export function generateId(): string {
  return crypto.randomUUID()
}
