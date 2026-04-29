// Write path entry point: sanitize, validate, then commit or reject

import { sanitizeAtom, generateId } from '../pipeline/sanitize'
import { validateAtom } from '../pipeline/validate'
import { traceDecision, mapValidationToResult } from '../pipeline/decision-trace'
import { insertAtom } from '../state/grimoire'
import type { GrimoireAtom, ValidationResult } from './types'

export interface IngestResult {
  atom?: GrimoireAtom
  validation: ValidationResult
  quality_gate?: {
    specificity_score: number | null
    flagged_for_review: boolean
    rejection_reason: string | null
  }
}

/**
 * Optional quality gate bindings. When provided (i.e., when called from a worker
 * with AI/Vectorize access), the quality gate runs before validation.
 * The gateway has no AI bindings, so it passes undefined.
 */
export interface QualityGateBindings {
  qualityGate: (input: { text: string; source: string; source_app?: string | null; metadata?: Record<string, unknown> },
    ctx: unknown, ai: Ai, vectorize: Vectorize, db: D1Database) => Promise<{
    pass: boolean; specificity_score: number | null; similar_atom_id: string | null;
    similar_atom_text: string | null; similarity_score: number | null;
    rejection_reason: string | null; flagged_for_review: boolean;
  }>
  ctx: unknown
  ai: Ai
  vectorize: Vectorize
}

export async function ingestAtom(
  db: D1Database,
  submission: Partial<GrimoireAtom>,
  gate?: QualityGateBindings
): Promise<IngestResult> {
  const start = Date.now()

  // Step 1: Sanitize
  const sanitized = sanitizeAtom(submission)
  if (!sanitized.id) sanitized.id = generateId()

  // Step 1b: Quality gate (when AI bindings available)
  if (gate) {
    const gateResult = await gate.qualityGate(
      { text: sanitized.text ?? '', source: sanitized.source ?? 'manual', source_app: sanitized.source_app, metadata: sanitized.metadata as Record<string, unknown> },
      gate.ctx, gate.ai, gate.vectorize, db
    )
    if (!gateResult.pass) {
      console.log(`ingest_gate_reject: id=${sanitized.id} reason=${gateResult.rejection_reason}`)
      return {
        validation: {
          valid: false,
          errors: [{ field: 'quality_gate', message: gateResult.rejection_reason || 'quality_gate_rejected', rule: 'quality_gate' }],
          warnings: [],
        },
        quality_gate: {
          specificity_score: gateResult.specificity_score,
          flagged_for_review: false,
          rejection_reason: gateResult.rejection_reason,
        },
      }
    }
  }

  // Step 2: Immune check
  const validation = await validateAtom(db, sanitized)
  const result = mapValidationToResult(validation)
  const durationMs = Date.now() - start

  await traceDecision(db, {
    atom_id: sanitized.id ?? null,
    trigger: 'write',
    checks_run: ['sanitize', 'required_fields', 'enum_check', 'fk_check', 'duplicate_check'],
    result,
    validation,
    duration_ms: durationMs,
  })

  // Step 3: Decision
  if (result === 'fail') {
    // Hard fail: do not insert
    console.log(`ingest_reject: id=${sanitized.id} errors=${validation.errors.length}`)
    return { validation }
  }

  // Pass or warn: insert atom
  const atom = sanitized as GrimoireAtom
  await insertAtom(db, atom)

  if (result === 'warn') {
    console.log(`ingest_warn: id=${atom.id} warnings=${validation.warnings.length}`)
  } else {
    console.log(`ingest_ok: id=${atom.id}`)
  }

  return { atom, validation }
}
