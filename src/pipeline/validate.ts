// Immune system entry point: structural validation of new atoms
// Checks category/collection existence, duplicate detection, required fields

import { checkCategoryExists, checkCollectionExists, checkDuplicate } from '../state/grimoire'
import type { GrimoireAtom, ValidationResult, ValidationError, ValidationWarning } from '../grimoire/types'

const REQUIRED_FIELDS: (keyof GrimoireAtom)[] = ['text', 'collection_slug', 'observation', 'source']
const VALID_OBSERVATIONS = ['observation', 'interpretation']
const VALID_SOURCES = ['seed', 'ai', 'manual']
const VALID_MODALITIES = ['visual', 'both']
const MIN_TEXT_LENGTH = 3
const MAX_TEXT_LENGTH = 1000

export async function validateAtom(
  db: D1Database,
  entry: Partial<GrimoireAtom>
): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  for (const field of REQUIRED_FIELDS) {
    if (!entry[field]) {
      errors.push({ field, message: `${field} is required`, rule: 'required' })
    }
  }

  if (errors.length > 0) return { valid: false, errors, warnings }

  const text = entry.text!
  const textLower = entry.text_lower ?? text.toLowerCase()

  if (text.length < MIN_TEXT_LENGTH) {
    errors.push({ field: 'text', message: `text too short (min ${MIN_TEXT_LENGTH})`, rule: 'min_length' })
  }
  if (text.length > MAX_TEXT_LENGTH) {
    errors.push({ field: 'text', message: `text too long (max ${MAX_TEXT_LENGTH})`, rule: 'max_length' })
  }

  if (!VALID_OBSERVATIONS.includes(entry.observation!)) {
    errors.push({ field: 'observation', message: `must be 'observation' or 'interpretation'`, rule: 'enum' })
  }
  if (!VALID_SOURCES.includes(entry.source!)) {
    errors.push({ field: 'source', message: `must be 'seed', 'ai', or 'manual'`, rule: 'enum' })
  }
  if (entry.modality && !VALID_MODALITIES.includes(entry.modality)) {
    errors.push({ field: 'modality', message: `must be 'visual' or 'both'`, rule: 'enum' })
  }

  if (errors.length > 0) return { valid: false, errors, warnings }

  const [catExists, colExists, isDuplicate] = await Promise.all([
    entry.category_slug ? checkCategoryExists(db, entry.category_slug) : Promise.resolve(true),
    checkCollectionExists(db, entry.collection_slug!),
    checkDuplicate(db, textLower, entry.collection_slug!),
  ])

  if (!colExists) {
    errors.push({ field: 'collection_slug', message: `collection '${entry.collection_slug}' does not exist`, rule: 'fk_collection' })
  }
  if (entry.category_slug && !catExists) {
    errors.push({ field: 'category_slug', message: `category '${entry.category_slug}' does not exist`, rule: 'fk_category' })
  }
  if (isDuplicate) {
    errors.push({ field: 'text', message: `exact duplicate in collection '${entry.collection_slug}'`, rule: 'duplicate' })
  }

  if (entry.confidence !== undefined && (entry.confidence < 0 || entry.confidence > 1)) {
    warnings.push({ field: 'confidence', message: 'confidence should be 0-1', suggestion: 'clamp to [0, 1]' })
  }

  return { valid: errors.length === 0, errors, warnings }
}

// ---------- Correspondence Validation ----------

export interface CorrespondenceInput {
  atom_a_id: string
  atom_b_id: string
  relationship_type: string
  provenance: string
  strength?: number
  arrangement_scope?: string | null
}

const VALID_RELATIONSHIP_TYPES = ['resonates', 'opposes', 'requires', 'substitutes', 'evokes']
const VALID_PROVENANCES = ['harmonic', 'semantic', 'exemplar', 'co_occurrence']

export async function validateCorrespondence(
  db: D1Database,
  corr: CorrespondenceInput
): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  if (!VALID_RELATIONSHIP_TYPES.includes(corr.relationship_type)) {
    errors.push({ field: 'relationship_type', message: `must be one of: ${VALID_RELATIONSHIP_TYPES.join(', ')}`, rule: 'enum' })
  }
  if (!VALID_PROVENANCES.includes(corr.provenance)) {
    errors.push({ field: 'provenance', message: `must be one of: ${VALID_PROVENANCES.join(', ')}`, rule: 'enum' })
  }
  if (errors.length > 0) return { valid: false, errors, warnings }

  const [atomAExists, atomBExists] = await Promise.all([
    db.prepare('SELECT id FROM atoms WHERE id = ? LIMIT 1').bind(corr.atom_a_id).first(),
    db.prepare('SELECT id FROM atoms WHERE id = ? LIMIT 1').bind(corr.atom_b_id).first(),
  ])
  if (!atomAExists) errors.push({ field: 'atom_a_id', message: `atom '${corr.atom_a_id}' does not exist`, rule: 'fk_atom' })
  if (!atomBExists) errors.push({ field: 'atom_b_id', message: `atom '${corr.atom_b_id}' does not exist`, rule: 'fk_atom' })
  if (errors.length > 0) return { valid: false, errors, warnings }

  const scope = corr.arrangement_scope ?? null
  const existing = await db.prepare(
    'SELECT id FROM correspondences WHERE atom_a_id = ? AND atom_b_id = ? AND relationship_type = ? AND arrangement_scope IS ? LIMIT 1'
  ).bind(corr.atom_a_id, corr.atom_b_id, corr.relationship_type, scope).first()
  if (existing) {
    errors.push({ field: 'atom_a_id', message: 'correspondence pair already exists', rule: 'unique_pair' })
  }

  return { valid: errors.length === 0, errors, warnings }
}

// ---------- Exemplar Validation ----------

export interface ExemplarInput {
  incantation_id: string
  atom_id: string
  slot_name: string
}

export async function validateExemplar(
  db: D1Database,
  exemplar: ExemplarInput
): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  const [incantationExists, atomExists, slotExists] = await Promise.all([
    db.prepare('SELECT id FROM incantations WHERE id = ? LIMIT 1').bind(exemplar.incantation_id).first(),
    db.prepare('SELECT id FROM atoms WHERE id = ? LIMIT 1').bind(exemplar.atom_id).first(),
    db.prepare('SELECT id FROM incantation_slots WHERE incantation_id = ? AND slot_name = ? LIMIT 1')
      .bind(exemplar.incantation_id, exemplar.slot_name).first(),
  ])

  if (!incantationExists) errors.push({ field: 'incantation_id', message: `incantation '${exemplar.incantation_id}' does not exist`, rule: 'fk_incantation' })
  if (!atomExists) errors.push({ field: 'atom_id', message: `atom '${exemplar.atom_id}' does not exist`, rule: 'fk_atom' })
  if (!slotExists) {
    warnings.push({ field: 'slot_name', message: `slot '${exemplar.slot_name}' not defined for this incantation`, suggestion: 'verify slot_name matches incantation_slots.slot_name' })
  }

  return { valid: errors.length === 0, errors, warnings }
}

// Returns count of correspondence rows referencing atomId.
// Caller surfaces this as a warning before rejection; does not block.
export async function checkAtomCorrespondenceRefs(db: D1Database, atomId: string): Promise<number> {
  const row = await db.prepare(
    'SELECT COUNT(*) as count FROM correspondences WHERE atom_a_id = ? OR atom_b_id = ?'
  ).bind(atomId, atomId).first<{ count: number }>()
  return row?.count ?? 0
}
