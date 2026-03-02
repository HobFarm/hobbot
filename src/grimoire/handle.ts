// GrimoireHandle factory: public query interface for agents
// No SQL here. All database operations delegate to state/grimoire.ts and state/graph.ts.

import {
  lookupAtom, searchAtoms, getRecommendations,
  getProviderRoute, getCategories, getCollections, getArrangements,
  getAtomCounts,
} from '../state/grimoire'
import {
  getCorrespondencesForAtom, getExemplarsForAtom,
  getIncantations, getIncantationBySlug,
  getCategoryRelations, getCorrespondenceStats,
  getExemplarCount, getIncantationCount,
} from '../state/graph'
import {
  insertDocument, updateDocumentStatus, getDocument,
  listDocuments, insertChunk, searchChunks, getDocumentCounts,
} from '../state/documents'
import {
  submitDiscovery, listDiscoveries, resolveDiscovery,
  getDiscoveryQueueCounts,
} from '../state/discovery'
import {
  getRelatedAtoms as queryRelatedAtoms, addRelation as insertRelation,
  queryProviderBehaviors, insertProviderBehavior,
} from '../state/relations'
import {
  insertIngestLog, getIngestLogByUrl, updateIngestLog, listIngestLogs,
} from '../state/ingest-log'
import {
  insertSource, getSource, insertSourceAtom, updateSourceAtomCount,
} from '../state/sources'
import { validateAtom } from '../pipeline/validate'
import { QUERY } from '../config'
import type {
  GrimoireHandle, GrimoireAtom, SearchOptions, CorrespondenceResult,
  ValidationResult, ProviderRecommendation, Category, Collection, Arrangement,
  Incantation, Exemplar, CategoryRelation, Correspondence, CorrespondenceQueryOptions,
  GrimoireStats, Document, DocumentChunk, ChunkSearchResult,
  DiscoveryEntry, ResolveOptions, ResolveResult,
  RelatedAtomResult, AddRelationInput, ProviderBehavior, ProviderBehaviorInput, ProviderBehaviorQuery,
  IngestLog, IngestLogStatus,
  SourceRecord,
} from './types'

export function createGrimoireHandle(db: D1Database): GrimoireHandle {
  return {
    async lookup(term: string): Promise<GrimoireAtom | null> {
      return lookupAtom(db, term)
    },

    async search(query: string, options: SearchOptions = {}): Promise<GrimoireAtom[]> {
      const limit = Math.min(
        options.limit ?? QUERY.DEFAULT_SEARCH_LIMIT,
        QUERY.MAX_SEARCH_LIMIT
      )
      return searchAtoms(db, query, { ...options, limit })
    },

    async correspondences(term: string, depth = QUERY.DEFAULT_CORRESPONDENCE_DEPTH): Promise<CorrespondenceResult> {
      const clampedDepth = Math.min(depth, QUERY.MAX_CORRESPONDENCE_DEPTH)
      const atom = await lookupAtom(db, term)
      if (!atom) {
        return { atom: { text: term } as GrimoireAtom, correspondences: [], category_siblings: [], exemplar_evidence: [] }
      }

      const [corrs, exemplar_evidence, category_siblings] = await Promise.all([
        getCorrespondencesForAtom(db, atom.id, { limit: 50 }),
        getExemplarsForAtom(db, atom.id),
        atom.category_slug
          ? searchAtoms(db, '', { category: atom.category_slug, limit: 20 })
          : Promise.resolve([] as GrimoireAtom[]),
      ])

      // Depth > 1: follow correspondence chains one level deeper
      // Depth 3+ not implemented; each level multiplies query count significantly
      let allCorrs = [...corrs]
      if (clampedDepth > 1 && corrs.length > 0) {
        const relatedIds = [
          ...new Set(
            corrs.flatMap(c => [c.atom_a_id, c.atom_b_id]).filter(id => id !== atom.id)
          )
        ].slice(0, 10)

        const depth2Batches = await Promise.all(
          relatedIds.map(id => getCorrespondencesForAtom(db, id, { limit: 10 }))
        )
        const seen = new Set(corrs.map(c => c.id))
        for (const batch of depth2Batches) {
          for (const c of batch) {
            if (!seen.has(c.id)) { seen.add(c.id); allCorrs.push(c) }
          }
        }
        allCorrs = allCorrs.slice(0, QUERY.MAX_SEARCH_LIMIT)
      }

      return { atom, correspondences: allCorrs, category_siblings, exemplar_evidence }
    },

    async recommend(intent: string, arrangement?: string): Promise<GrimoireAtom[]> {
      return getRecommendations(db, intent, arrangement)
    },

    async validate(entry: Partial<GrimoireAtom>): Promise<ValidationResult> {
      return validateAtom(db, entry)
    },

    async route(taskType: string): Promise<ProviderRecommendation> {
      return getProviderRoute(db, taskType)
    },

    async categories(): Promise<Category[]> {
      return getCategories(db)
    },

    async collections(): Promise<Collection[]> {
      return getCollections(db)
    },

    async arrangements(): Promise<Arrangement[]> {
      return getArrangements(db)
    },

    async incantations(): Promise<Incantation[]> {
      return getIncantations(db)
    },

    async incantation(slug: string): Promise<Incantation | null> {
      return getIncantationBySlug(db, slug)
    },

    async exemplarsFor(atomId: string): Promise<Exemplar[]> {
      return getExemplarsForAtom(db, atomId)
    },

    async categoryRelations(slug?: string): Promise<CategoryRelation[]> {
      return getCategoryRelations(db, slug)
    },

    async correspondencesRaw(atomId: string, options?: CorrespondenceQueryOptions): Promise<Correspondence[]> {
      return getCorrespondencesForAtom(db, atomId, options)
    },

    async stats(): Promise<GrimoireStats> {
      const [atomCounts, correspondenceStats, exemplarCount, incantationCount, docCounts, discoveryCounts] = await Promise.all([
        getAtomCounts(db),
        getCorrespondenceStats(db),
        getExemplarCount(db),
        getIncantationCount(db),
        getDocumentCounts(db),
        getDiscoveryQueueCounts(db),
      ])
      return {
        atom_counts: atomCounts,
        correspondence_stats: correspondenceStats,
        exemplar_count: exemplarCount,
        incantation_count: incantationCount,
        document_count: docCounts.document_count,
        chunk_count: docCounts.chunk_count,
        discovery_queue: discoveryCounts,
        generated_at: new Date().toISOString(),
      }
    },

    // ---------- Knowledge Layer: Documents ----------

    async documentAdd(doc: Omit<Document, 'created_at' | 'updated_at'>): Promise<Document> {
      await insertDocument(db, doc)
      const result = await getDocument(db, doc.id)
      return result!.document
    },

    async documentGet(id: string): Promise<{ document: Document; chunks: DocumentChunk[] } | null> {
      return getDocument(db, id)
    },

    async documentsList(opts?: { status?: string; mime_type?: string; source_app?: string; limit?: number }): Promise<Document[]> {
      return listDocuments(db, opts)
    },

    async documentUpdateStatus(id: string, status: Document['status'], chunk_count?: number): Promise<void> {
      await updateDocumentStatus(db, id, status, chunk_count)
    },

    async documentChunkAdd(chunk: Omit<DocumentChunk, 'created_at'>): Promise<DocumentChunk> {
      await insertChunk(db, chunk)
      return { ...chunk, created_at: new Date().toISOString() }
    },

    async documentChunkSearch(query: string, opts?: { category?: string; arrangement?: string; document_id?: string; limit?: number }): Promise<ChunkSearchResult[]> {
      return searchChunks(db, query, opts)
    },

    // ---------- Knowledge Layer: Discovery Queue ----------

    async discoverySubmit(entry: Omit<DiscoveryEntry, 'status' | 'resolved_atom_id' | 'duplicate_of_atom_id' | 'resolution_note' | 'resolved_at' | 'created_at'>): Promise<DiscoveryEntry> {
      return submitDiscovery(db, entry)
    },

    async discoveryList(opts?: { status?: string; source_app?: string; limit?: number }): Promise<DiscoveryEntry[]> {
      return listDiscoveries(db, opts)
    },

    async discoveryResolve(id: string, resolution: ResolveOptions): Promise<ResolveResult> {
      return resolveDiscovery(db, id, resolution)
    },

    // ---------- Knowledge Layer: Atom Relations ----------

    async getRelatedAtoms(atomId: string, opts?: { relation_type?: string; direction?: 'outgoing' | 'incoming' | 'both'; limit?: number }): Promise<RelatedAtomResult[]> {
      return queryRelatedAtoms(db, atomId, opts)
    },

    async addRelation(input: AddRelationInput): Promise<{ id: string; created: boolean }> {
      return insertRelation(db, input)
    },

    // ---------- Knowledge Layer: Provider Behaviors ----------

    async getProviderBehaviors(query?: ProviderBehaviorQuery): Promise<ProviderBehavior[]> {
      return queryProviderBehaviors(db, query)
    },

    async logProviderBehavior(input: ProviderBehaviorInput): Promise<{ id: string }> {
      return insertProviderBehavior(db, input)
    },

    // ---------- Knowledge Ingest Pipeline ----------

    async ingestLogInsert(log: Omit<IngestLog, 'created_at' | 'completed_at'>): Promise<void> {
      await insertIngestLog(db, log)
    },

    async ingestLogByUrl(url: string): Promise<IngestLog | null> {
      return getIngestLogByUrl(db, url)
    },

    async ingestLogUpdate(id: string, updates: {
      status?: IngestLogStatus
      atoms_created?: number
      atoms_skipped?: number
      relations_created?: number
      extraction_json?: Record<string, unknown>
      error_message?: string
      completed_at?: string
    }): Promise<void> {
      await updateIngestLog(db, id, updates)
    },

    async ingestLogList(opts?: { status?: string; source_type?: string; limit?: number }): Promise<IngestLog[]> {
      return listIngestLogs(db, opts)
    },

    // ---------- Image Sources ----------

    async sourceAdd(source: SourceRecord): Promise<void> {
      return insertSource(db, source)
    },

    async sourceGet(id: string): Promise<SourceRecord | null> {
      return getSource(db, id)
    },

    async sourceAtomLink(sourceId: string, atomId: string, confidence: number, method: string): Promise<void> {
      return insertSourceAtom(db, sourceId, atomId, confidence, method)
    },

    async sourceUpdateAtomCount(id: string, count: number): Promise<void> {
      return updateSourceAtomCount(db, id, count)
    },
  }
}
