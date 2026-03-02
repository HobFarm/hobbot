// Core type definitions for the Grimoire custodian

export interface GrimoireAtom {
  id: string
  text: string
  text_lower: string
  collection_slug: string
  category_slug: string | null
  observation: 'observation' | 'interpretation'
  status: 'provisional' | 'confirmed' | 'rejected'
  confidence: number
  encounter_count: number
  tags: string[]
  source: 'seed' | 'ai' | 'manual'
  source_app: string | null
  metadata: Record<string, unknown>
  harmonics: Record<string, unknown>
  modality: 'visual' | 'both'
  embedding_status: 'pending' | 'processing' | 'complete' | 'failed'
  register: number | null
  created_at: string
  updated_at: string
}

// D1 row shape: JSON fields stored as TEXT
export interface AtomRow extends Omit<GrimoireAtom, 'tags' | 'metadata' | 'harmonics'> {
  tags: string
  metadata: string
  harmonics: string
}

export function safeJson<T>(val: string | null | undefined, fallback: T): T {
  if (!val) return fallback
  try { return JSON.parse(val) as T } catch { return fallback }
}

export function fromRow(row: AtomRow): GrimoireAtom {
  return {
    ...row,
    tags: safeJson(row.tags, []),
    metadata: safeJson(row.metadata, {}),
    harmonics: safeJson(row.harmonics, {}),
  }
}

export function toRow(atom: Partial<GrimoireAtom>): Partial<AtomRow> {
  const row: Record<string, unknown> = { ...atom }
  if (atom.tags !== undefined) row.tags = JSON.stringify(atom.tags)
  if (atom.metadata !== undefined) row.metadata = JSON.stringify(atom.metadata)
  if (atom.harmonics !== undefined) row.harmonics = JSON.stringify(atom.harmonics)
  return row as Partial<AtomRow>
}

export interface Category {
  slug: string
  parent: string
  label: string
  description: string
  output_schema: string
}

export interface Collection {
  slug: string
  name: string
  description: string | null
  parent_slug: string | null
}

export interface ArrangementRow extends Omit<Arrangement, 'harmonics' | 'category_weights'> {
  harmonics: string
  category_weights: string
}

export interface Arrangement {
  slug: string
  name: string
  description: string | null
  harmonics: Record<string, unknown>
  category_weights: Record<string, unknown>
  context_key: string | null
  register: number | null
}

export function fromArrangementRow(row: ArrangementRow): Arrangement {
  return {
    ...row,
    harmonics: safeJson(row.harmonics, {}),
    category_weights: safeJson(row.category_weights, {}),
  }
}

// ---------- Phase 1 Graph Types ----------

// Direct relationship between two atoms in the correspondences table
export interface Correspondence {
  id: string
  atom_a_id: string
  atom_b_id: string
  relationship_type: 'resonates' | 'opposes' | 'requires' | 'substitutes' | 'evokes'
  strength: number
  provenance: 'harmonic' | 'semantic' | 'exemplar' | 'co_occurrence'
  arrangement_scope: string | null
  metadata: Record<string, unknown>
  created_at: string
}

// Prompt template with named slots
export interface Incantation {
  id: string
  name: string
  slug: string
  description: string | null
  modality: 'visual' | 'narrative' | 'both'
  genre: string | null
  template_text: string | null
  metadata: Record<string, unknown>
  slots: IncantationSlot[]
  created_at: string
}

// Named slot within an incantation template
export interface IncantationSlot {
  id: string
  incantation_id: string
  slot_name: string
  category_filter: string | null
  required: boolean
  sort_order: number
}

// Evidence of an atom appearing in a known-good prompt slot
export interface Exemplar {
  id: string
  incantation_id: string
  slot_name: string
  atom_id: string
  frequency: number
  source_file: string | null
  metadata: Record<string, unknown>
  created_at: string
}

// Inter-category relationship
export interface CategoryRelation {
  source_slug: string
  target_slug: string
  relation: 'overlaps' | 'contains' | 'excludes' | 'pairs_with'
  note: string | null
}

// Options for raw correspondence queries
export interface CorrespondenceQueryOptions {
  relationship_type?: Correspondence['relationship_type']
  provenance?: Correspondence['provenance']
  arrangement_scope?: string
  min_strength?: number
  limit?: number
}

// Aggregated stats across the correspondence graph
export interface CorrespondenceStats {
  byType: Record<string, number>
  byProvenance: Record<string, number>
  total: number
}

// Full grimoire stats for the /stats endpoint
export interface GrimoireStats {
  atom_counts: Record<string, number>
  correspondence_stats: CorrespondenceStats
  exemplar_count: number
  incantation_count: number
  document_count: number
  chunk_count: number
  discovery_queue: Record<string, number>
  generated_at: string
}

export interface SearchOptions {
  category?: string
  collection?: string
  arrangement?: string
  modality?: 'visual' | 'both'
  status?: 'provisional' | 'confirmed' | 'rejected'
  limit?: number
}

export interface CorrespondenceResult {
  atom: GrimoireAtom
  correspondences: Correspondence[]
  category_siblings: GrimoireAtom[]
  exemplar_evidence: Exemplar[]
}

export interface ValidationResult {
  valid: boolean
  errors: ValidationError[]
  warnings: ValidationWarning[]
  suggested_corrections?: Partial<GrimoireAtom>
}

export interface ValidationError {
  field: string
  message: string
  rule: string
}

export interface ValidationWarning {
  field: string
  message: string
  suggestion: string
}

export interface ProviderRecommendation {
  provider: 'gemini' | 'claude' | 'grok' | 'openai'
  confidence: number
  prompt_hint: string
  known_failures: string[]
}

export interface GrimoireHandle {
  // Atom queries
  lookup(term: string): Promise<GrimoireAtom | null>
  search(query: string, options?: SearchOptions): Promise<GrimoireAtom[]>
  correspondences(term: string, depth?: number): Promise<CorrespondenceResult>
  recommend(intent: string, arrangement?: string): Promise<GrimoireAtom[]>
  validate(entry: Partial<GrimoireAtom>): Promise<ValidationResult>
  route(taskType: string): Promise<ProviderRecommendation>

  // Taxonomy
  categories(): Promise<Category[]>
  collections(): Promise<Collection[]>
  arrangements(): Promise<Arrangement[]>

  // Phase 1 graph tables
  incantations(): Promise<Incantation[]>
  incantation(slug: string): Promise<Incantation | null>
  exemplarsFor(atomId: string): Promise<Exemplar[]>
  categoryRelations(slug?: string): Promise<CategoryRelation[]>
  correspondencesRaw(atomId: string, options?: CorrespondenceQueryOptions): Promise<Correspondence[]>
  stats(): Promise<GrimoireStats>

  // Knowledge Layer: Documents
  documentAdd(doc: Omit<Document, 'created_at' | 'updated_at'>): Promise<Document>
  documentGet(id: string): Promise<{ document: Document; chunks: DocumentChunk[] } | null>
  documentsList(opts?: { status?: string; mime_type?: string; source_app?: string; limit?: number }): Promise<Document[]>
  documentUpdateStatus(id: string, status: Document['status'], chunk_count?: number): Promise<void>
  documentChunkAdd(chunk: Omit<DocumentChunk, 'created_at'>): Promise<DocumentChunk>
  documentChunkSearch(query: string, opts?: { category?: string; arrangement?: string; document_id?: string; limit?: number }): Promise<ChunkSearchResult[]>

  // Knowledge Layer: Discovery Queue
  discoverySubmit(entry: Omit<DiscoveryEntry, 'status' | 'resolved_atom_id' | 'duplicate_of_atom_id' | 'resolution_note' | 'resolved_at' | 'created_at'>): Promise<DiscoveryEntry>
  discoveryList(opts?: { status?: string; source_app?: string; limit?: number }): Promise<DiscoveryEntry[]>
  discoveryResolve(id: string, resolution: ResolveOptions): Promise<ResolveResult>

  // Knowledge Layer: Atom Relations
  getRelatedAtoms(atomId: string, opts?: { relation_type?: string; direction?: 'outgoing' | 'incoming' | 'both'; limit?: number }): Promise<RelatedAtomResult[]>
  addRelation(input: AddRelationInput): Promise<{ id: string; created: boolean }>

  // Knowledge Layer: Provider Behaviors
  getProviderBehaviors(query?: ProviderBehaviorQuery): Promise<ProviderBehavior[]>
  logProviderBehavior(input: ProviderBehaviorInput): Promise<{ id: string }>

  // Knowledge Ingest Pipeline
  ingestLogInsert(log: Omit<IngestLog, 'created_at' | 'completed_at'>): Promise<void>
  ingestLogByUrl(url: string): Promise<IngestLog | null>
  ingestLogUpdate(id: string, updates: {
    status?: IngestLogStatus
    atoms_created?: number
    atoms_skipped?: number
    relations_created?: number
    extraction_json?: Record<string, unknown>
    error_message?: string
    completed_at?: string
  }): Promise<void>
  ingestLogList(opts?: { status?: string; source_type?: string; limit?: number }): Promise<IngestLog[]>

  // Image Sources
  sourceAdd(source: SourceRecord): Promise<void>
  sourceGet(id: string): Promise<SourceRecord | null>
  sourceAtomLink(sourceId: string, atomId: string, confidence: number, method: string): Promise<void>
  sourceUpdateAtomCount(id: string, count: number): Promise<void>
}

export interface UsageLogEntry {
  id: number
  agent: string
  endpoint: string
  query: string
  atom_ids_returned: string
  response_time_ms: number
  timestamp: string
}

export interface IntegrityScanResult {
  id: number
  scan_type: 'full' | 'write_validation' | 'on_demand' | 'evolve'
  atoms_scanned: number
  issues_found: number
  issues: string
  duration_ms: number
  timestamp: string
}

export interface IntegrityIssue {
  type: 'orphan' | 'circular_ref' | 'missing_category' | 'duplicate' | 'coverage_gap' | 'embedding_gap' | 'orphaned_ref'
  atom_id?: string
  description: string
  severity: 'low' | 'medium' | 'high'
}

export interface AgentBudget {
  agent: string
  queries_today: number
  queries_limit: number
  last_query_at: string | null
  budget_date: string
}

// ---------- Knowledge Layer Types ----------

// Source material registered in the Grimoire
export interface Document {
  id: string
  title: string
  description: string | null
  mime_type: string
  r2_key: string | null
  source_url: string | null
  tags: string[]
  token_count: number | null
  chunk_count: number
  status: 'pending' | 'chunking' | 'chunked' | 'failed'
  source_app: string | null
  created_at: string
  updated_at: string
}

export interface DocumentRow extends Omit<Document, 'tags'> {
  tags: string
}

export function fromDocumentRow(row: DocumentRow): Document {
  return { ...row, tags: safeJson(row.tags, []) }
}

// Searchable pieces of knowledge derived from documents
export interface DocumentChunk {
  id: string
  document_id: string
  chunk_index: number
  content: string
  summary: string | null
  token_count: number | null
  category_slug: string | null
  arrangement_slugs: string[]
  metadata: Record<string, unknown>
  created_at: string
}

export interface DocumentChunkRow extends Omit<DocumentChunk, 'arrangement_slugs' | 'metadata'> {
  arrangement_slugs: string
  metadata: string
}

export function fromChunkRow(row: DocumentChunkRow): DocumentChunk {
  return {
    ...row,
    arrangement_slugs: safeJson(row.arrangement_slugs, []),
    metadata: safeJson(row.metadata, {}),
  }
}

export interface ChunkSearchResult extends DocumentChunk {
  document_title: string
}

export interface ChunkSearchResultRow extends DocumentChunkRow {
  document_title: string
}

// Quality gate for new atoms from any source
export interface DiscoveryEntry {
  id: string
  term: string
  ir_slot: string | null
  arrangement_slug: string | null
  source_app: string
  source_context: Record<string, unknown>
  status: 'pending' | 'accepted' | 'rejected' | 'merged'
  resolution_note: string | null
  resolved_atom_id: string | null
  duplicate_of_atom_id: string | null
  suggested_category: string | null
  suggested_collection: string | null
  created_at: string
  resolved_at: string | null
}

export interface DiscoveryEntryRow extends Omit<DiscoveryEntry, 'source_context'> {
  source_context: string
}

export function fromDiscoveryRow(row: DiscoveryEntryRow): DiscoveryEntry {
  return { ...row, source_context: safeJson(row.source_context, {}) }
}

export interface ResolveOptions {
  action: 'accept' | 'reject' | 'merge'
  note?: string
  // For accept: atom creation fields
  collection_slug?: string
  category_slug?: string
  observation?: 'observation' | 'interpretation'
  harmonics?: Record<string, unknown>
  confidence?: number
  // For merge: existing atom this duplicates
  duplicate_of_atom_id?: string
}

export interface ResolveResult {
  atom?: GrimoireAtom
  queue_entry: DiscoveryEntry
  validation?: ValidationResult
}

// ---------- Knowledge Layer: Atom Relations ----------

export type AtomRelationType = 'compositional' | 'oppositional' | 'hierarchical' | 'modifies' | 'co_occurs' | 'derives_from'
export type AtomRelationSource = 'curated' | 'discovered' | 'inferred' | 'observed'

export interface AtomRelation {
  id: string
  source_atom_id: string
  target_atom_id: string
  relation_type: AtomRelationType
  strength: number
  context: string | null
  source: AtomRelationSource
  confidence: number
  created_at: string
  updated_at: string
}

export interface RelatedAtomResult {
  relation_id: string
  related_atom: { id: string; text: string; collection_slug: string; category_slug: string | null }
  relation_type: AtomRelationType
  strength: number
  context: string | null
  source: AtomRelationSource
  confidence: number
  direction: 'outgoing' | 'incoming'
}

export interface AddRelationInput {
  source_atom_id: string
  target_atom_id: string
  relation_type: AtomRelationType
  strength?: number
  context?: string | null
  source?: AtomRelationSource
  confidence?: number
}

// ---------- Knowledge Layer: Provider Behaviors ----------

export type ProviderBehaviorSeverity = 'info' | 'warning' | 'breaking'

export interface ProviderBehavior {
  id: string
  provider: string
  atom_id: string | null
  atom_category: string | null
  behavior: string
  render_mode: string | null
  severity: ProviderBehaviorSeverity
  observed_at: string
}

export interface ProviderBehaviorInput {
  provider: string
  atom_id?: string | null
  atom_category?: string | null
  behavior: string
  render_mode?: string | null
  severity?: ProviderBehaviorSeverity
}

export interface ProviderBehaviorQuery {
  provider?: string
  atom_id?: string
  atom_category?: string
  render_mode?: string
  severity?: string
}

// ---------- Knowledge Ingest Pipeline ----------

export type IngestSourceType = 'aesthetic' | 'domain'
export type IngestLogStatus = 'pending' | 'processing' | 'complete' | 'failed'

export interface IngestLog {
  id: string
  url: string
  source_type: IngestSourceType
  status: IngestLogStatus
  atoms_created: number
  atoms_skipped: number
  relations_created: number
  extraction_json: Record<string, unknown> | null
  error_message: string | null
  dry_run: boolean
  created_at: string
  completed_at: string | null
}

export interface IngestLogRow extends Omit<IngestLog, 'extraction_json' | 'dry_run'> {
  extraction_json: string | null
  dry_run: number
}

export function fromIngestLogRow(row: IngestLogRow): IngestLog {
  return {
    ...row,
    extraction_json: safeJson(row.extraction_json, null),
    dry_run: row.dry_run === 1,
  }
}

// Gemini extraction output shapes

export interface AestheticExtraction {
  aesthetic_name: string
  visual_atoms: string[]
  color_atoms: string[]
  material_atoms: string[]
  atmospheric_phrases: string[]
  related_aesthetics: AestheticRelation[]
  harmonic_profile: Record<string, string>
}

export interface AestheticRelation {
  name: string
  relation: 'parent' | 'child' | 'sibling' | 'influence' | 'opposite'
}

export interface DomainExtraction {
  topic_name: string
  visual_atoms: string[]
  conceptual_atoms: string[]
  atmospheric_phrases: string[]
  proper_nouns: string[]
  style_references: string[]
}

// ---------- Image Sources ----------

export interface SourceRecord {
  id: string
  type: 'moodboard' | 'reference' | 'generation' | 'document'
  filename: string | null
  mime_type: string | null
  r2_key: string | null
  source_url: string | null
  metadata: Record<string, unknown>
  aesthetic_tags: string[]
  arrangement_matches: { slug: string; confidence: number; reasoning?: string }[]
  harmonic_profile: Record<string, string>
  atom_count: number
  created_at: string
}

export interface KnowledgeIngestRequest {
  url: string
  source_type: IngestSourceType
  collection_slug?: string
  dry_run?: boolean
}

export interface KnowledgeIngestResult {
  ingest_log: IngestLog
  atoms_created: string[]
  atoms_skipped: string[]
  relations_created: string[]
  dry_run: boolean
}
