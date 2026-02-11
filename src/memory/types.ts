// Memory system types for HobBot's processed memory

export type KnowledgeType =
  | 'user_narrative'
  | 'community_insight'
  | 'topic_expertise'
  | 'engagement_strategy';

export interface MemoryReflection {
  id: number;
  cycle_timestamp: string;
  cycle_hour: number;
  posts_discovered: number;
  posts_engaged: number;
  attacks_cataloged: number;
  replies_sent: number;
  learning_summary: string | null;
  knowledge_updates: string | null;
  anomalies: string | null;
  reflection_cost: number;
  created_at: string;
}

export interface MemoryKnowledge {
  id: number;
  knowledge_type: KnowledgeType;
  knowledge_key: string;
  content: string;
  structured_data: string | null;
  confidence: number;
  evidence_count: number;
  first_created_at: string;
  last_updated_at: string;
  last_evidence_at: string;
  decay_applied_at: string | null;
}

export interface NotableInteraction {
  postId: string;
  submolt: string;
  authorHash: string;
  authorName?: string;
  score: number;
  action: 'engaged' | 'cataloged' | 'deflected' | 'skipped' | 'replied';
  threatLevel: number;
  shape?: string;
  topics?: string[];
  contentSummary?: string;
}

export interface CycleEvents {
  postsDiscovered: number;
  postsEngaged: number;
  attacksCataloged: number;
  postsFailed: number;
  repliesSent: number;
  notableInteractions: NotableInteraction[];
}

export interface MemoryContext {
  digest: string | null;
  relevantKnowledge: MemoryKnowledge[];
  recentLearnings: string[];
  combinedPromptBlock: string;
}

export interface KnowledgeUpdate {
  type: KnowledgeType;
  key: string;
  content: string;
  structured_data?: Record<string, unknown>;
}

export interface ReflectionResult {
  reflectionId: number;
  learningSummary: string;
  knowledgeUpdates: number;
}
