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
  adapter: 'url' | 'text' | 'text-url' | 'text-r2' | 'image' | 'feed_entry' | 'pdf' | 'reddit'
  fetched_at?: string
  ingested_at?: string
  original_url?: string
  feed_entry_id?: number
  image_r2_key?: string
  pdf_r2_key?: string
  r2_key?: string
  collection_slug?: string
  arrangement_hints?: string[]
  bibliography_detected?: boolean
  reddit?: {
    subreddit: string
    author: string
    score: number
    created_utc: number
    num_comments: number
    is_self: boolean
    external_url: string | null
  }
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
  // Curated R2 ingest fields. Set by the queue consumer (from-image-r2 path) so
  // the vision prompt is primed with source language/domain context and the
  // resulting NormalizedDocument carries the canonical r2:// source URL instead
  // of the synthetic CDN upload URL.
  meta_context?: { language?: string; domain?: string; notes?: string; title?: string }
  canonical_source_url?: string
  source_slug?: string
  skip_r2_upload?: boolean
}

export interface IngestFromPdfParams {
  url?: string              // URL to a PDF (e.g. archive.org download link)
  r2_key?: string           // already uploaded to R2
  pdf_base64?: string       // raw base64 content
  filename?: string         // original filename
  title?: string            // override extracted title
  source_type?: 'aesthetic' | 'domain' | 'curated_r2'
  collection_slug?: string
  tags?: string[]
  arrangement_hints?: string[]  // e.g. ['bauhaus', 'constructivism'] - helps tagger
  dry_run?: boolean
}

export interface IngestFromTextUrlParams {
  url: string                // URL to a plain-text file (e.g. archive.org djvu.txt)
  filename?: string          // optional filename hint for provenance
  title?: string             // override title (otherwise derived from URL)
  source_type?: 'aesthetic' | 'domain'
  collection_slug?: string
  tags?: string[]
  arrangement_hints?: string[]
  dry_run?: boolean
}

// Fire-and-forget result. ingestTextOnly stops after chunk creation; enrichment
// is left to the cron sweep (or manual /internal/enrich-trigger).
export interface IngestTextOnlyResult {
  document_id: string
  source_id: string
  chunk_count: number
  status: 'complete' | 'no_content' | 'already_ingested'
  enrichment: 'queued' | 'skipped'
  ingest_log?: Record<string, unknown>
}

// Same shape as IngestTextOnlyResult but for the PDF path. Mirrors the
// fire-and-forget pattern: fetch + extract + chunk, no inline enrichment.
export interface IngestPdfOnlyResult {
  document_id: string
  source_id: string
  chunk_count: number
  status: 'complete' | 'no_content' | 'already_ingested'
  enrichment: 'queued' | 'skipped'
  ingest_log?: Record<string, unknown>
}

export interface IngestFromRedditParams {
  url: string                                       // Reddit post permalink
  source_type?: 'aesthetic' | 'domain'
  collection_slug?: string
  tags?: string[]
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
  ingestFromTextUrl(params: IngestFromTextUrlParams): Promise<PipelineResult>
  ingestTextOnly(params: IngestFromTextUrlParams): Promise<IngestTextOnlyResult>
  ingestPdfOnly(params: IngestFromPdfParams): Promise<IngestPdfOnlyResult>
  ingestFromReddit(params: IngestFromRedditParams): Promise<PipelineResult>
  classifyImage(params: ClassifyImageParams): Promise<unknown>
  runBlogPipeline(channel?: string): Promise<unknown>
  runBridge(): Promise<unknown>
  publishDraft(id: number): Promise<unknown>
}
