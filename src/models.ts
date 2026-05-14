// --- Task Types ---

export type TaskType =
  | 'validate.duplicate'        // AI duplicate check
  | 'image.analyze'             // Vision classification (Workers AI primary, Gemini fallback)
  | 'image.analyze.curated'     // Curated R2 ingest vision (Kimi K2.6 on Workers AI). Reads brand text + translates non-English body copy.
  | 'knowledge.extract'         // knowledge ingest extraction (legacy, kept for backward compat)
  | 'blog.compose'              // blog post generation (Nemotron primary, Gemini fallback)
  | 'pipeline.enrichment'       // per-chunk enrichment: summary, categories, arrangements, concepts (also used by cron safety net)
  // chunk.summary and moodboard.aggregate live in workers/grimoire/src/models.ts (authoritative for grimoire-only tasks)
  | 'pipeline.vocabulary'       // vocabulary matching: semantic disambiguation
  | 'pipeline.indexing'         // new vocabulary entry classification
  | 'pipeline.correspondence'   // relation identification between concepts
  // Custodian tasks (moved from workers/hobbot-custodian/src/models.ts)
  | 'custodian.intent'          // Gap -> search intent (Nemotron)
  | 'custodian.queries'         // Intent -> IA queries (Qwen3)
  | 'custodian.score'           // Candidate -> relevance score (Granite)
  | 'lineage.discover'          // Orphan arrangement -> proposed lineage edges (Qwen3 primary, GLM fallback)
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
  // Workers AI primary, Workers AI fallback per global rule. Mistral Small 3.1
  // is a different vision family from Llama 4 Scout, so a Scout failure mode
  // (e.g. JSON parse error from truncated thinking, vision attention miss) is
  // unlikely to repeat on Mistral. No external-provider fallback by design.
  'image.analyze': {
    primary: {
      provider: 'workers-ai',
      model: '@cf/meta/llama-4-scout-17b-16e-instruct',
      options: { temperature: 0.1, maxOutputTokens: 4096 },
    },
    fallbacks: [
      {
        provider: 'workers-ai',
        model: '@cf/mistralai/mistral-small-3.1-24b-instruct',
        options: { temperature: 0.1, maxOutputTokens: 4096 },
      },
    ],
  },
  // Curated ingest path: Kimi K2.6 on Workers AI. Phase 4.5 Step D makes this
  // a clean cut from Grok: no external xAI call and no silent fallback, so GLB
  // batch validation sees Kimi failures directly instead of masking them behind
  // lower-quality extraction from the old chain.
  'image.analyze.curated': {
    primary: {
      provider: 'workers-ai',
      model: '@cf/moonshotai/kimi-k2.6',
      // Dense catalog pages can produce long enumerated_items arrays plus body
      // translations. Keep the larger output budget validated during the Kimi
      // canary rather than falling back to the standard vision budget.
      options: { temperature: 0.1, maxOutputTokens: 8192, responseFormat: 'json' },
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
  // Structured JSON extraction tasks: thinkingBudget=0 disables reasoning so the
  // full output budget goes to the JSON payload, not chain-of-thought tokens.
  // Fallbacks moved from Gemini to Workers AI on 2026-05-04 to satisfy the
  // global "Workers AI primary + Workers AI fallback" rule. glm-4.7-flash is a
  // different family from Qwen3/Granite (ZAI vs Alibaba/IBM), so a primary
  // failure mode is unlikely to repeat on fallback. 131K context handles long
  // wiki sections without truncation.
  // Audit Slice 4 rollout task 3 (2026-05-14): GLM-4.7-Flash promoted from
  // fallback to primary; Qwen3-30b moved to fallback. Justified by data — over
  // the prior 3 days Qwen3 succeeded 8 times vs GLM-fallback succeeding 18
  // times on this task key (69% fallback firing rate), meaning Qwen3 primary
  // was silently failing on most attempts and GLM was already the de facto
  // primary. Promotion makes the effective behavior the official behavior.
  // Revert is a one-commit flip.
  'pipeline.enrichment': {
    primary: {
      provider: 'workers-ai',
      model: '@cf/zai-org/glm-4.7-flash',
      options: { temperature: 0.2, maxOutputTokens: 4096, responseFormat: 'json' },
    },
    fallbacks: [{
      provider: 'workers-ai',
      model: '@cf/qwen/qwen3-30b-a3b-fp8',
      options: { temperature: 0.2, maxOutputTokens: 4096, thinkingBudget: 0 },
    }],
  },
  // Audit Slice 4 rollout (2026-05-14, follows lineage.discover Step-3D canary):
  // GLM-4.7-Flash promoted from fallback to primary; Granite Micro moved to
  // fallback. Post-promotion lineage.discover canary showed 6.7% fallback
  // firing rate (1 Qwen3 fallback vs 14 GLM successes), well under the 20%
  // tripwire. First pipeline.* key in the rollout (lowest-risk: bounded JSON,
  // per-batch vocab match, easy to revert via one-commit registry flip).
  'pipeline.vocabulary': {
    primary: {
      provider: 'workers-ai',
      model: '@cf/zai-org/glm-4.7-flash',
      options: { temperature: 0.1, maxOutputTokens: 1024, responseFormat: 'json' },
    },
    fallbacks: [{
      provider: 'workers-ai',
      model: '@cf/ibm-granite/granite-4.0-h-micro',
      options: { temperature: 0.1, maxOutputTokens: 1024, thinkingBudget: 0 },
    }],
  },
  // Audit Slice 4 rollout task 4 (2026-05-14): GLM-4.7-Flash promoted to
  // primary; Qwen3-30b moved to fallback. Sparse observed traffic (only 1
  // fallback firing in the past 3 days), but the same Qwen3-fails-silently
  // pattern showed up here as on pipeline.enrichment. Promotion is symmetric
  // with the other Qwen3-based task keys. Revert is a one-commit flip.
  'pipeline.indexing': {
    primary: {
      provider: 'workers-ai',
      model: '@cf/zai-org/glm-4.7-flash',
      options: { temperature: 0.1, maxOutputTokens: 4096, responseFormat: 'json' },
    },
    fallbacks: [{
      provider: 'workers-ai',
      model: '@cf/qwen/qwen3-30b-a3b-fp8',
      options: { temperature: 0.1, maxOutputTokens: 4096, thinkingBudget: 0 },
    }],
  },
  // Audit Slice 4 rollout task 2 (2026-05-14, follows pipeline.vocabulary):
  // GLM-4.7-Flash promoted from fallback to primary; Granite Micro moved to
  // fallback. Same shape as task 1 (pipeline.vocabulary); both promoted in
  // the same operator session given lineage.discover canary (6.7% fallback)
  // plus the Qwen3-silent-failure pattern found on pipeline.enrichment which
  // strengthens the GLM-as-primary case across pipeline.*. Revert is a
  // one-commit flip.
  'pipeline.correspondence': {
    primary: {
      provider: 'workers-ai',
      model: '@cf/zai-org/glm-4.7-flash',
      options: { temperature: 0.1, maxOutputTokens: 2048, responseFormat: 'json' },
    },
    fallbacks: [{
      provider: 'workers-ai',
      model: '@cf/ibm-granite/granite-4.0-h-micro',
      options: { temperature: 0.1, maxOutputTokens: 2048, thinkingBudget: 0 },
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

  // --- Lineage gap discovery ---
  // Given an orphan arrangement (no inbound or outbound lineage edges), the
  // model proposes up to 5 relationships from the existing arrangement list.
  // Cultural-history reasoning task; ~70 candidate slugs as context. Workers AI
  // primary + Workers AI fallback per global rule.
  //
  // Audit Slice 4 promotion (2026-05-13, Step 3D canary): GLM-4.7-Flash
  // promoted from fallback to primary; Qwen3-30b moved to fallback. Canary
  // task for the broader pipeline.* promotion; lowest-traffic site (fires only
  // on orphan-arrangement detection in custodian's 6h cron, not per-chunk).
  // Revert is a one-commit registry flip if GLM quality regresses.
  // Caveat: WorkersAIProvider.generateResponse does NOT forward responseFormat
  // to env.AI.run (see HobBot/src/providers/workers-ai.ts), so the
  // `responseFormat: 'json'` option is descriptive metadata — JSON-mode
  // enforcement comes from prompt engineering, not the provider call.
  // GLM-4.7-Flash has been firing in the fallback slot under this same
  // constraint; promotion to primary changes which path is the default attempt.
  'lineage.discover': {
    primary: {
      provider: 'workers-ai',
      model: '@cf/zai-org/glm-4.7-flash',
      options: { temperature: 0.2, maxOutputTokens: 1024, responseFormat: 'json' },
    },
    fallbacks: [{
      provider: 'workers-ai',
      model: '@cf/qwen/qwen3-30b-a3b-fp8',
      options: { temperature: 0.2, maxOutputTokens: 1024, thinkingBudget: 0 },
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
  // Conversation history summarization. BART removed 2026-05-10 (Cloudflare
  // planned deprecation). Now uses chat-completions shape via WorkersAIProvider
  // in workers/hobbot-chat/src/services/summarize.ts. Plain text output (no
  // JSON wrapper); the service trims and clips defensively before persisting.
  //
  // Primary: llama-3.3-70b-instruct-fp8-fast @ 512 tokens — non-thinking,
  // already proven elsewhere in the registry (agent.compose fallback,
  // chunk.summary primary on the grimoire worker as of 2026-05-10), reliable
  // text output. 512 tokens gives headroom for a multi-sentence digest of
  // an old-message batch. Qwen3 retained as fallback at 4096 tokens (absorbs
  // its <think> block so the budget is never eaten before the answer); on
  // Qwen3 fallback the consumer must strip <think>...</think> blocks before
  // persisting. Nemotron as last-resort fallback.
  'chat.summarize': {
    primary: {
      provider: 'workers-ai',
      model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      options: { temperature: 0.2, maxOutputTokens: 512 },
    },
    fallbacks: [
      {
        provider: 'workers-ai',
        model: '@cf/qwen/qwen3-30b-a3b-fp8',
        options: { temperature: 0.2, maxOutputTokens: 4096 },
      },
      {
        provider: 'workers-ai',
        model: '@cf/nvidia/nemotron-3-120b-a12b',
        options: { temperature: 0.2, maxOutputTokens: 512 },
      },
    ],
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
    notes: '131K context, function calling, Workers AI native. In use as fallback for pipeline.{enrichment,vocabulary,indexing,correspondence} since 2026-05-04.',
  },
  'bart-large-cnn': {
    model: '@cf/facebook/bart-large-cnn',
    context: 1024,
    functionCalling: false,
    notes: 'DEPRECATED 2026-05-10 (Cloudflare planned deprecation list). Was used for chat history + chunk summarization; both migrated to chat-completions models (llama-3.3-fp8-fast primary). Entry retained for catalog reference; do not assign to new tasks.',
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
