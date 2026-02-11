// Lucid Dream types: 24h deep synthesis module

import type { KnowledgeType } from '../memory/types';

export interface PatternSnapshot {
  pattern_id: string;
  pattern_name: string;
  category: string;
  structural_description: string;
  geometric_metaphor: string | null;
  observed_count: number;
  generation_seeds: string[];
  first_seen_at: string;
  last_seen_at: string;
  active: number;
}

export interface PatternEvolution {
  pattern_id: string;
  pattern_name: string;
  previous_description: string | null;
  current_description: string;
  previous_count: number | null;
  current_count: number;
  change_summary: string;
}

export interface ResearchFinding {
  pattern_id: string;
  pattern_name: string;
  query: string;
  post_count: number;
  avg_score: number;
  top_submolts: string[];
  validation_signal: 'confirmed' | 'emerging' | 'unvalidated' | 'contradicted';
  evidence_summary: string;
}

export interface GlossaryDraft {
  term: string;
  definition: string;
  relevance: string;
  example: string;
  source_patterns: string[];
  confidence: number;
}

export interface PatternRefinement {
  pattern_id: string;
  refined_description: string;
  reasoning: string;
}

// Synthesis AI returns glossary suggestions with singular source_pattern (string),
// distinct from GlossaryDraft which has computed source_patterns (string[]) and confidence.
// DreamSynthesis uses this; glossary.ts uses GlossaryDraft.
export interface GlossaryCandidate {
  term: string;
  definition: string;
  relevance: string;
  example: string;
  source_pattern: string;
}

export interface DMFeedbackSignal {
  conversationId: string;
  participant: string;
  signalType: 'positive' | 'negative';
  messageSummary: string;
}

export interface CommunityVibe {
  topTopics: string[];
  vibeDescription: string;
  hotSubmolts: string[];
}

export interface OwnPostPerformance {
  postId: string;
  title: string;
  submolt: string;
  commentCount: number;
  createdAt: string;
}

export interface DreamSynthesis {
  synthesis_summary: string;
  knowledge_updates: Array<{
    type: KnowledgeType;
    key: string;
    content: string;
    structured_data?: Record<string, unknown>;
  }>;
  pattern_refinements: PatternRefinement[];
}

export interface DreamResult {
  dreamId: number;
  patternsEvolved: number;
  researchFindings: number;
  glossaryDraftsCreated: number;
  glossaryDraftsPromoted: number;
  synthesisSummary: string;
  tokenCost: number;
  needsDigestRebuild: boolean;
  dmSignalsFound: number;
  communityVibe: string | null;
}
