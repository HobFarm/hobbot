// Grimoire tool manifests: single source of truth for tools exposed on both MCP and chat.
// These 8 tools are the overlap set (exist on both surfaces).
// MCP-only tools remain as direct server.tool() calls in mcp/server.ts.

import { z } from 'zod'
import type { ToolManifest } from '../types'

export const GRIMOIRE_SEARCH: ToolManifest = {
  name: 'grimoire_search',
  description: 'Search Grimoire atoms by text query with optional filters',
  category: 'grimoire',
  surfaces: ['mcp', 'chat'],
  auth: 'none',
  inputSchema: z.object({
    q: z.string().describe('Search query text'),
    category: z.string().optional().describe('Filter by category slug'),
    collection: z.string().optional().describe('Filter by collection slug'),
    limit: z.number().min(1).max(100).default(20).describe('Max results to return'),
  }),
  hooks: { post: ['ledger_log'] },
}

export const GRIMOIRE_LOOKUP: ToolManifest = {
  name: 'grimoire_lookup',
  description: 'Look up a specific atom by exact term',
  category: 'grimoire',
  surfaces: ['mcp', 'chat'],
  auth: 'none',
  inputSchema: z.object({
    term: z.string().describe('Exact atom term to look up'),
  }),
  hooks: { post: ['ledger_log'] },
}

export const GRIMOIRE_RECOMMEND: ToolManifest = {
  name: 'grimoire_recommend',
  description: 'Get arrangement-aware atom recommendations for a creative intent',
  category: 'grimoire',
  surfaces: ['mcp', 'chat'],
  auth: 'none',
  inputSchema: z.object({
    intent: z.string().describe('Creative intent or concept to get recommendations for'),
    arrangement: z.string().optional().describe('Arrangement slug for style weighting (e.g. "atomic-noir", "cyberpunk")'),
  }),
  hooks: { post: ['ledger_log'] },
}

export const GRIMOIRE_CORRESPONDENCES: ToolManifest = {
  name: 'grimoire_correspondences',
  description: 'Get correspondence graph for a term: related atoms, category siblings, exemplar evidence',
  category: 'grimoire',
  surfaces: ['mcp', 'chat'],
  auth: 'none',
  inputSchema: z.object({
    term: z.string().describe('Atom term to get correspondences for'),
    depth: z.number().min(1).max(5).default(2).describe('Graph traversal depth'),
  }),
  hooks: { post: ['ledger_log'] },
}

export const GRIMOIRE_ARRANGEMENTS: ToolManifest = {
  name: 'grimoire_arrangements',
  description: 'List all available arrangements (style profiles) with their harmonic signatures and category weights',
  category: 'grimoire',
  surfaces: ['mcp', 'chat'],
  auth: 'none',
  inputSchema: z.object({}),
  hooks: { post: ['ledger_log'] },
}

export const GRIMOIRE_CATEGORIES: ToolManifest = {
  name: 'grimoire_categories',
  description: 'List all atom categories with descriptions and output schemas',
  category: 'grimoire',
  surfaces: ['mcp', 'chat'],
  auth: 'none',
  inputSchema: z.object({}),
  hooks: { post: ['ledger_log'] },
}

export const GRIMOIRE_DOCUMENT_SEARCH: ToolManifest = {
  name: 'grimoire_document_search',
  description: 'Search document chunks by text content. Returns matching chunks with their document titles and summaries. Use for finding knowledge about a topic.',
  category: 'grimoire',
  surfaces: ['mcp', 'chat'],
  auth: 'none',
  inputSchema: z.object({
    query: z.string().describe('Search text'),
    category: z.string().optional().describe('Filter by category slug'),
    arrangement: z.string().optional().describe('Filter by arrangement slug'),
    document_id: z.string().optional().describe('Filter to chunks from a specific document'),
    limit: z.number().min(1).max(100).default(20).describe('Max results'),
  }),
  hooks: { post: ['ledger_log'] },
}

export const GRIMOIRE_STATS: ToolManifest = {
  name: 'grimoire_stats',
  description: 'Get Grimoire health stats: atom counts by status, correspondence stats, exemplar count, incantation count, document count',
  category: 'grimoire',
  surfaces: ['mcp', 'chat'],
  auth: 'none',
  inputSchema: z.object({}),
  hooks: { post: ['ledger_log'] },
}

export const GRIMOIRE_MANIFESTS: ToolManifest[] = [
  GRIMOIRE_SEARCH,
  GRIMOIRE_LOOKUP,
  GRIMOIRE_RECOMMEND,
  GRIMOIRE_CORRESPONDENCES,
  GRIMOIRE_ARRANGEMENTS,
  GRIMOIRE_CATEGORIES,
  GRIMOIRE_DOCUMENT_SEARCH,
  GRIMOIRE_STATS,
]
