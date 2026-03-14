// Shared types for hobbot-pipeline RPC contract
// Imported by gateway directly, by pipeline worker via @shared/rpc/pipeline-types

// === PIPELINE INTERNAL TYPES ===

/** Every knowledge source normalizes to this before entering the pipeline */
export interface NormalizedDocument {
  title: string
  content_blocks: ContentBlock[]
  source_url?: string
  source_type: 'aesthetic' | 'domain'
  mime_type: string
  tags: string[]
  provenance: DocumentProvenance
}

export interface ContentBlock {
  heading?: string
  content: string
  token_count: number
}

export interface DocumentProvenance {
  adapter: 'url' | 'text' | 'image' | 'feed_entry' | 'pdf'
  fetched_at?: string
  original_url?: string
  feed_entry_id?: number
  image_r2_key?: string
  pdf_r2_key?: string
  collection_slug?: string
  arrangement_hints?: string[]
  bibliography_detected?: boolean
}

export interface ChunkResult {
  chunk_id: string
  content: string
  section_heading?: string
  token_count: number
  quality_score: number
}

export interface KeyConcept {
  text: string
  category_hint?: string
  harmonic_hint?: Record<string, number>
  confidence: number
  source_chunk_id: string
}

export interface MatchResult {
  concept: KeyConcept
  matched_atom_id?: string
  match_method?: 'exact' | 'fts5' | 'semantic'
  unmatched: boolean
}

export interface PipelineResult {
  document_id: string
  source_id: string
  chunks_created: number
  concepts_extracted: number
  atoms_matched: number
  atoms_created: number
  relations_created: number
  step_status: Record<string, string>
  errors: string[]
  dry_run: boolean
  // Legacy compatibility: gateway MCP tools reference these
  ingest_log?: Record<string, unknown>
}

// === RPC CONTRACT (gateway calls pipeline via service binding) ===

export interface IngestFromUrlParams {
  url: string
  source_type?: 'aesthetic' | 'domain'
  collection_slug?: string
  tags?: string[]
  dry_run?: boolean
}

export interface IngestFromTextParams {
  title: string
  content: string
  source_type?: 'aesthetic' | 'domain'
  collection_slug?: string
  tags?: string[]
  dry_run?: boolean
}

export interface IngestBatchParams {
  urls: Array<{ url: string; source_type?: 'aesthetic' | 'domain' }>
  collection_slug?: string
  dry_run?: boolean
}

export interface IngestFromImageParams {
  image_base64?: string
  image_url?: string
  r2_key?: string
  mime_type: string
  filename: string
  collection_slug?: string
  dry_run?: boolean
}

export interface IngestFromPdfParams {
  url?: string              // URL to a PDF (e.g. archive.org download link)
  r2_key?: string           // already uploaded to R2
  pdf_base64?: string       // raw base64 content
  filename?: string         // original filename
  title?: string            // override extracted title
  source_type?: 'aesthetic' | 'domain'
  collection_slug?: string
  tags?: string[]
  arrangement_hints?: string[]  // e.g. ['bauhaus', 'constructivism'] - helps tagger
  dry_run?: boolean
}

export interface ClassifyImageParams {
  image_base64?: string
  image_url?: string
  r2_key?: string
  mime_type: string
}

export interface PipelineRPC {
  ingestFromUrl(params: IngestFromUrlParams): Promise<PipelineResult>
  ingestFromText(params: IngestFromTextParams): Promise<PipelineResult>
  ingestBatch(params: IngestBatchParams): Promise<PipelineResult[]>
  ingestFromImage(params: IngestFromImageParams): Promise<PipelineResult>
  ingestFromPdf(params: IngestFromPdfParams): Promise<PipelineResult>
  classifyImage(params: ClassifyImageParams): Promise<unknown>
  runBlogPipeline(channel?: string): Promise<unknown>
  runBridge(): Promise<unknown>
  publishDraft(id: number): Promise<unknown>
}
