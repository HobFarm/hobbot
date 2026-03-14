// --- Task Types ---

export type TaskType =
  | 'validate.duplicate'   // AI duplicate check
  | 'image.analyze'        // Gemini Vision classification
  | 'knowledge.extract'    // knowledge ingest extraction (legacy, kept for backward compat)
  | 'chunk.enrich'         // async chunk enrichment cron (safety net)
  | 'blog.compose'         // blog post generation
  | 'pipeline.enrichment'  // per-chunk enrichment: summary, categories, arrangements, concepts
  | 'pipeline.vocabulary'  // vocabulary matching: semantic disambiguation
  | 'pipeline.indexing'    // new vocabulary entry classification
  | 'pipeline.correspondence' // relation identification between concepts

export type ProviderType = 'gemini' | 'workers-ai'

// --- Model Entry ---

export interface ModelEntry {
  provider: ProviderType
  model: string
  options?: {
    temperature?: number
    maxOutputTokens?: number
    thinkingBudget?: number
  }
}

// --- Task Config ---

export interface TaskConfig {
  primary: ModelEntry
  fallbacks: ModelEntry[]
}

// --- MODELS Config ---

export const MODELS: Record<TaskType, TaskConfig> = {
  'validate.duplicate': {
    primary: {
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      options: { temperature: 0.1, maxOutputTokens: 200 },
    },
    fallbacks: [],
  },
  'image.analyze': {
    primary: {
      provider: 'gemini',
      model: 'gemini-2.5-flash',
    },
    fallbacks: [],
  },
  'knowledge.extract': {
    primary: {
      provider: 'gemini',
      model: 'gemini-2.5-flash',
    },
    fallbacks: [],
  },
  'chunk.enrich': {
    primary: {
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      options: { temperature: 0.2, maxOutputTokens: 1024 },
    },
    fallbacks: [],
  },
  'blog.compose': {
    primary: {
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      options: { temperature: 0.8, maxOutputTokens: 4096 },
    },
    fallbacks: [],
  },
  'pipeline.enrichment': {
    primary: {
      provider: 'workers-ai',
      model: '@cf/qwen/qwen3-30b-a3b-fp8',
      options: { temperature: 0.2, maxOutputTokens: 4096 },
    },
    fallbacks: [{
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      options: { temperature: 0.2, maxOutputTokens: 2048 },
    }],
  },
  'pipeline.vocabulary': {
    primary: {
      provider: 'workers-ai',
      model: '@cf/ibm-granite/granite-4.0-h-micro',
      options: { temperature: 0.1, maxOutputTokens: 1024 },
    },
    fallbacks: [{
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      options: { temperature: 0.1, maxOutputTokens: 1024 },
    }],
  },
  'pipeline.indexing': {
    primary: {
      provider: 'workers-ai',
      model: '@cf/ibm-granite/granite-4.0-h-micro',
      options: { temperature: 0.1, maxOutputTokens: 1024 },
    },
    fallbacks: [{
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      options: { temperature: 0.1, maxOutputTokens: 1024 },
    }],
  },
  'pipeline.correspondence': {
    primary: {
      provider: 'workers-ai',
      model: '@cf/ibm-granite/granite-4.0-h-micro',
      options: { temperature: 0.1, maxOutputTokens: 2048 },
    },
    fallbacks: [{
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      options: { temperature: 0.1, maxOutputTokens: 2048 },
    }],
  },
}
