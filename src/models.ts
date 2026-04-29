// --- Task Types ---

export type TaskType =
  | 'validate.duplicate'        // AI duplicate check
  | 'image.analyze'             // Vision classification (Workers AI primary, Gemini fallback)
  | 'knowledge.extract'         // knowledge ingest extraction (legacy, kept for backward compat)
  | 'blog.compose'              // blog post generation (Nemotron primary, Gemini fallback)
  | 'pipeline.enrichment'       // per-chunk enrichment: summary, categories, arrangements, concepts (also used by cron safety net)
  | 'chunk.summary'             // single-purpose chunk summary (Workers-AI-only chain, used by grimoire BulkSummarizeWorkflow backfill)
  | 'pipeline.vocabulary'       // vocabulary matching: semantic disambiguation
  | 'pipeline.indexing'         // new vocabulary entry classification
  | 'pipeline.correspondence'   // relation identification between concepts
  | 'moodboard.aggregate'       // synthesize N per-image IRs into one aggregate moodboard IR (Qwen3 -> Nemotron, workers-ai only)
  // Custodian tasks (moved from workers/hobbot-custodian/src/models.ts)
  | 'custodian.intent'          // Gap -> search intent (Nemotron)
  | 'custodian.queries'         // Intent -> IA queries (Qwen3)
  | 'custodian.score'           // Candidate -> relevance score (Granite)
  // Chat tasks (moved from config.ts CHAT constants)
  | 'chat.primary'              // Primary chat model (gpt-oss-120b)
  | 'chat.fallback'             // Workers AI fallback (Qwen3)
  | 'chat.dashscope'            // External fallback (DashScope qwen-plus)
  | 'chat.summarize'            // Conversation history summarization (BART, summarization API not chat completions)
  // Classifier tasks (moved from workers/grimoire-classifier/src/ai.ts)
  | 'classifier.batch'          // Bulk atom classification + harmonics (Nemotron primary, Gemini fallback)
  // Agent tasks (moved from workers/hobbot-agent/src/models.ts)
  | 'agent.compose'             // X post text composition (Llama 70B primary, Claude fallback)
  | 'agent.signal'              // Trending signal gathering (Grok, skip on fail)
  | 'agent.validate'            // Content safety (Llama Guard, inline fallback)
  | 'agent.classify'            // Post categorization (Gemini Flash Lite primary, Llama 8B fallback)
  | 'agent.visualize'           // Image generation (FLUX-2 Dev primary, FLUX-1 + Lucid fallbacks)

export type ProviderType = 'gemini' | 'workers-ai' | 'dashscope' | 'anthropic' | 'xai' | 'inline'

// --- Model Entry ---

export interface ModelEntry {
  provider: ProviderType
  model: string
  options?: {
    temperature?: number
    maxOutputTokens?: number
    thinkingBudget?: number
    responseFormat?: 'json' | 'text'
  }
}

// --- Task Config ---

export interface TaskConfig {
  primary: ModelEntry
  fallbacks: ModelEntry[]
  onAllFail?: 'skip' | 'throw'
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
      provider: 'workers-ai',
      model: '@cf/meta/llama-4-scout-17b-16e-instruct',
      options: { temperature: 0.1, maxOutputTokens: 4096 },
    },
    fallbacks: [
      {
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        options: { temperature: 0.1, maxOutputTokens: 4096 },
      },
      {
        provider: 'gemini',
        model: 'gemini-2.5-flash-lite',
        options: { temperature: 0.1, maxOutputTokens: 4096 },
      },
    ],
  },
  'knowledge.extract': {
    primary: {
      provider: 'gemini',
      model: 'gemini-2.5-flash',
    },
    fallbacks: [],
  },
  'blog.compose': {
    primary: {
      provider: 'workers-ai',
      model: '@cf/nvidia/nemotron-3-120b-a12b',
      options: { temperature: 0.8, maxOutputTokens: 4096 },
    },
    fallbacks: [{
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      options: { temperature: 0.8, maxOutputTokens: 4096 },
    }],
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
  // Single-purpose chunk summary for backfill. Workers-AI-only chain per the
  // "Workers AI primary, Workers AI fallback" rule for new call sites.
  // Returns plain text (no JSON wrapper), short outputs.
  // chunk.summary uses a dual-path scheme inside BulkSummarizeWorkflow:
  //   - chunks <= 3000 chars: BART (@cf/facebook/bart-large-cnn) called
  //     directly via env.AI.run() because it uses the Summarization task
  //     type ({ input_text, max_length }), not chat completions. Free, fast,
  //     no thinking. Workflow-only exception to the "no raw env.AI.run" rule.
  //   - chunks > 3000 chars: GLM-4.7-Flash via the chat completions API
  //     and the provider abstraction below.
  // The registry entry only describes the GLM path so callWithFallback
  // dispatches correctly. BART routing is a workflow-internal detail.
  'chunk.summary': {
    primary: {
      provider: 'workers-ai',
      model: '@cf/zai-org/glm-4.7-flash',
      options: { temperature: 0.2, maxOutputTokens: 256 },
    },
    fallbacks: [],
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
      model: '@cf/qwen/qwen3-30b-a3b-fp8',
      options: { temperature: 0.1, maxOutputTokens: 4096 },
    },
    fallbacks: [{
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      options: { temperature: 0.1, maxOutputTokens: 4096 },
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

  // Moodboard aggregation: N per-image IRs -> one aggregate IR with invariants/vectors/low_freq buckets.
  // Workers-AI-only chain by design. On total failure, caller leaves moodboard row in 'extracted' and retries later.
  'moodboard.aggregate': {
    primary: {
      provider: 'workers-ai',
      model: '@cf/qwen/qwen3-30b-a3b-fp8',
      options: { temperature: 0.3, maxOutputTokens: 4096, responseFormat: 'json' },
    },
    fallbacks: [{
      provider: 'workers-ai',
      model: '@cf/nvidia/nemotron-3-120b-a12b',
      options: { temperature: 0.3, maxOutputTokens: 4096, responseFormat: 'json' },
    }],
  },

  // --- Custodian tasks (moved from workers/hobbot-custodian/src/models.ts) ---

  // Gap data -> targeted search intent. Needs reasoning for abstract-to-concrete translation.
  'custodian.intent': {
    primary: {
      provider: 'workers-ai',
      model: '@cf/nvidia/nemotron-3-120b-a12b',
      options: { temperature: 0.3, maxOutputTokens: 512 },
    },
    fallbacks: [{
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      options: { temperature: 0.3, maxOutputTokens: 512 },
    }],
  },
  // Search intent -> 2-3 IA query strings. Fast structured JSON output.
  'custodian.queries': {
    primary: {
      provider: 'workers-ai',
      model: '@cf/qwen/qwen3-30b-a3b-fp8',
      options: { temperature: 0.3, maxOutputTokens: 512 },
    },
    fallbacks: [{
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      options: { temperature: 0.3, maxOutputTokens: 512 },
    }],
  },
  // Candidate metadata -> 0-1 relevance score. Runs up to 30x per cycle, minimum cost.
  'custodian.score': {
    primary: {
      provider: 'workers-ai',
      model: '@cf/ibm-granite/granite-4.0-h-micro',
      options: { temperature: 0.1, maxOutputTokens: 128 },
    },
    fallbacks: [{
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      options: { temperature: 0.1, maxOutputTokens: 128 },
    }],
  },

  // --- Chat tasks (moved from config.ts CHAT constants) ---
  // Chat fallback chain is managed by chat worker's getModelCandidates(),
  // not by shared callWithFallback (shared provider has no streaming support).
  // Each entry here is a single model, not a chain. The chat worker reads
  // .primary.model from each and sequences them in its own fallback logic.

  'chat.primary': {
    primary: {
      provider: 'workers-ai',
      model: '@cf/openai/gpt-oss-120b',
      options: { temperature: 0.7, maxOutputTokens: 4096 },
    },
    fallbacks: [],
  },
  'chat.fallback': {
    primary: {
      provider: 'workers-ai',
      model: '@cf/qwen/qwen3-30b-a3b-fp8',
      options: { temperature: 0.7, maxOutputTokens: 4096 },
    },
    fallbacks: [],
  },
  'chat.dashscope': {
    primary: {
      provider: 'dashscope',
      model: 'qwen-plus',
      options: { temperature: 0.7, maxOutputTokens: 4096 },
    },
    fallbacks: [],
  },
  // Conversation history summarization. BART is a purpose-built summarization
  // model with a different API surface than chat models: it takes
  // { input_text, max_length } and returns { summary }, NOT a messages array.
  // Called directly via env.AI.run() in workers/hobbot-chat/src/services/summarize.ts.
  // The registry entry exists so the model string is centralized; the dispatch
  // is workflow-internal because callWithFallback's chat-completions assumption
  // doesn't apply. On BART failure, summarize.ts falls back to message
  // truncation in-process (no model-level fallback needed).
  'chat.summarize': {
    primary: {
      provider: 'workers-ai',
      model: '@cf/facebook/bart-large-cnn',
    },
    fallbacks: [],
  },

  // --- Classifier tasks (moved from workers/grimoire-classifier/src/ai.ts) ---

  // Bulk classification: category + harmonics for up to 100 atoms per call.
  // High maxOutputTokens for batch JSON response. thinkingBudget 0 for Gemini.
  'classifier.batch': {
    primary: {
      provider: 'workers-ai',
      model: '@cf/nvidia/nemotron-3-120b-a12b',
      options: { temperature: 0.1, maxOutputTokens: 8192 },
    },
    fallbacks: [{
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      options: { temperature: 0.1, maxOutputTokens: 8192, thinkingBudget: 0 },
    }],
  },

  // --- Agent tasks (moved from workers/hobbot-agent/src/models.ts) ---

  'agent.compose': {
    primary: {
      provider: 'workers-ai',
      model: '@cf/nvidia/nemotron-3-120b-a12b',
      options: { temperature: 0.8, maxOutputTokens: 512, responseFormat: 'json' },
    },
    fallbacks: [
      {
        provider: 'workers-ai',
        model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
        options: { temperature: 0.8, maxOutputTokens: 512, responseFormat: 'json' },
      },
      {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        options: { temperature: 0.8, maxOutputTokens: 512 },
      },
    ],
  },
  'agent.signal': {
    primary: {
      provider: 'xai',
      model: 'grok-4.1-fast',
      options: { temperature: 0.5, maxOutputTokens: 2048 },
    },
    fallbacks: [],
    onAllFail: 'skip',
  },
  'agent.validate': {
    primary: {
      provider: 'workers-ai',
      model: '@cf/meta/llama-guard-3-8b',
    },
    fallbacks: [
      { provider: 'inline', model: 'rules-only' },
    ],
  },
  'agent.classify': {
    primary: {
      provider: 'gemini',
      model: 'gemini-3.1-flash-lite-preview',
      options: { temperature: 0.1, maxOutputTokens: 1024, thinkingBudget: 0 },
    },
    fallbacks: [{
      provider: 'workers-ai',
      model: '@cf/meta/llama-3.1-8b-instruct',
      options: { temperature: 0.1, maxOutputTokens: 1024, responseFormat: 'json' },
    }],
  },
  'agent.visualize': {
    primary: {
      provider: 'workers-ai',
      model: '@cf/black-forest-labs/flux-2-dev',
    },
    fallbacks: [
      { provider: 'workers-ai', model: '@cf/black-forest-labs/flux-1-schnell' },
      { provider: 'workers-ai', model: '@cf/leonardo/lucid-origin' },
    ],
  },
}

// --- Available Workers AI Models ---
// Validated for use but not yet assigned to tasks. Later briefs assign these.
// Directory: https://developers.cloudflare.com/workers-ai/models/
// Use the directory (not `wrangler ai models --search`) to verify model strings;
// CLI search has incomplete coverage of non-text-generation task types.

export interface WorkersAIModelInfo {
  model: string
  context: number
  functionCalling: boolean
  notes: string
}

export const AVAILABLE_WORKERS_AI: Record<string, WorkersAIModelInfo> = {
  'nemotron-120b': {
    model: '@cf/nvidia/nemotron-3-120b-a12b',
    context: 32000,
    functionCalling: true,
    notes: '120B MoE (12B active), $0.50/$1.50 per M tokens, OpenAI-compatible response format',
  },
  'glm-4.7-flash': {
    model: '@cf/zai-org/glm-4.7-flash',
    context: 131000,
    functionCalling: true,
    notes: '131K context, function calling, Workers AI native. Potential chat fallback.',
  },
  'bart-large-cnn': {
    model: '@cf/facebook/bart-large-cnn',
    context: 1024,
    functionCalling: false,
    notes: 'Purpose-built summarization model. Candidate for chat history summarization (Phase 4).',
  },
  'detr-resnet-50': {
    model: '@cf/facebook/detr-resnet-50',
    context: 0,
    functionCalling: false,
    notes: 'Object detection with bounding boxes. $0.0000075/req. Candidate for image asset analysis.',
  },
  'llama-guard-3-8b': {
    model: '@cf/meta/llama-guard-3-8b',
    context: 8192,
    functionCalling: false,
    notes: 'Content safety classification. Candidate for pre-publish safety gate.',
  },
}
