// Decision trace logging: full provenance for validation decisions

import { logValidationEvent } from '../state/audit'
import type { ValidationResult } from '../grimoire/types'
import type { AuditTrigger } from '../state/audit'

export interface DecisionTrace {
  atom_id: string | null
  trigger: AuditTrigger
  checks_run: string[]
  result: 'pass' | 'warn' | 'fail'
  validation: ValidationResult
  duration_ms: number
}

export async function traceDecision(db: D1Database, trace: DecisionTrace): Promise<void> {
  const details = {
    checks_run: trace.checks_run,
    errors: trace.validation.errors,
    warnings: trace.validation.warnings,
    duration_ms: trace.duration_ms,
  }

  await logValidationEvent(db, trace.trigger, trace.atom_id, trace.result, details)
  console.log(`decision_trace: atom=${trace.atom_id ?? 'new'} result=${trace.result} checks=${trace.checks_run.length} ms=${trace.duration_ms}`)
}

export function mapValidationToResult(v: ValidationResult): 'pass' | 'warn' | 'fail' {
  if (!v.valid) return 'fail'
  if (v.warnings.length > 0) return 'warn'
  return 'pass'
}
