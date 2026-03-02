// Write path entry point: sanitize, validate, then commit or reject

import { sanitizeAtom, generateId } from '../pipeline/sanitize'
import { validateAtom } from '../pipeline/validate'
import { traceDecision, mapValidationToResult } from '../pipeline/decision-trace'
import { insertAtom } from '../state/grimoire'
import type { GrimoireAtom, ValidationResult } from './types'

export interface IngestResult {
  atom?: GrimoireAtom
  validation: ValidationResult
}

export async function ingestAtom(
  db: D1Database,
  submission: Partial<GrimoireAtom>
): Promise<IngestResult> {
  const start = Date.now()

  // Step 1: Sanitize
  const sanitized = sanitizeAtom(submission)
  if (!sanitized.id) sanitized.id = generateId()

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
