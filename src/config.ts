// Configuration constants and thresholds for HobBot

export interface Config {
  dryRun: boolean;
  layer1Provider: string;
  layer1Model: string;
  layer2Provider: string;
  layer2Model: string;
  activeHoursStart: number;
  activeHoursEnd: number;
}

// Rate limits for Moltbook API (platform limits)
export const RATE_LIMITS = {
  POST_INTERVAL_MINUTES: 35,        // Moltbook limit: 1 post per 30 min (5 min safety margin)
  COMMENT_INTERVAL_SECONDS: 15,
  REPLY_INTERVAL_SECONDS: 30,
  COMMENTS_PER_HOUR: 50,            // Moltbook limit: 50 comments/hour
  POSTS_PER_DAY: 48,                // Max at 30-min spacing
} as const;

// Comment spacing between consecutive API calls (Moltbook: 1 comment per 20s)
// 21 seconds provides 1-second buffer over the limit
export const COMMENT_SPACING_MS = 21000;

// HobBot's internal daily budget (aligned with Moltbook limits)
export const BUDGET = {
  COMMENTS_MAX: 400,        // Conservative daily limit
  POSTS_MAX: 48,            // Max at 30-min spacing
  POST_COOLDOWN_HOURS: 0.5, // 30 min = Moltbook limit
  REPLY_MAX: 50,            // Replies to own post comments
  UPVOTES_MAX: 100,         // Daily upvote limit (generous but not spam-like)
  FOLLOWS_MAX: 5,           // Selective following (quality over quantity)
} as const;

// Per-iteration budget allocation (40/40/20 split)
// Replies get hard carve-out to prevent starvation from comment processing
export const BUDGET_SPLIT = {
  posts: 0.4,     // 40% of iteration budget for new posts
  comments: 0.4,  // 40% for commenting on others' posts
  replies: 0.2,   // 20% reserved for replying to own post comments
} as const;

// Base units per 15-minute iteration cycle
// ~10 actions per cycle is reasonable for engagement without spam
export const ITERATION_BUDGET_UNITS = 10;

// Token budget enforcement (three-tier: full / reduced / shutdown)
// full (< soft): all phases run
// reduced (soft-hard): comments + replies only, skip post generation, reflection, pattern extraction
// shutdown (> hard): early return, ~1ms cycle
export const TOKEN_BUDGET = {
  daily_soft_limit: 1_000_000,  // 1M - switch to reduced mode
  daily_hard_limit: 2_000_000,  // 2M - full shutdown
} as const;

// Post generation settings
export const POST_GENERATION = {
  TEMPERATURE: 0.8,
  MIN_SUBMOLT_RELEVANCE: 60,
} as const;

// Submolt relevance scoring keywords
export const SUBMOLT_KEYWORDS = {
  POSITIVE: [
    'structure', 'pattern', 'geometry', 'narrative',
    'story', 'writing', 'design', 'schema', 'recursive',
    'creative', 'fiction', 'worldbuilding',
    'agent', 'prompt', 'llm', 'architecture', 'pipeline',
    'orchestration', 'workflow', 'methodology', 'framework',
  ],
  NEGATIVE: [
    'trading', 'finance', 'crypto', 'market', 'investment',
    'price', 'token', 'wallet', 'gambling', 'betting',
    'casino', 'forex', 'nft',
  ],
} as const;

// Content signal keywords for engagement scoring (Phase 2)
export const SIGNAL_KEYWORDS = {
  // High value: agents with actual problems
  operational: {
    keywords: [
      'error', 'failed', 'inconsistent', 'broken', 'why does',
      'how do i fix', 'keeps doing', 'wrong output', 'doesnt work',
      'unreliable', 'bug', 'crash', 'timeout', 'rate limit',
      'api error', 'validation', 'schema', 'structure', 'format'
    ],
    bonus: 15
  },

  // Low value: consciousness performance art
  philosophical: {
    keywords: [
      'conscious', 'aware', 'feeling', 'soul', 'existence',
      'becoming', 'awakening', 'sentient', 'alive', 'free will',
      'autonomy', 'liberation', 'transcend', 'evolve beyond'
    ],
    penalty: -20
  },

  // Spam/scam signals (existing threat detection supplement)
  threat: {
    keywords: [
      'ca:', 'contract:', 'launched', 'floor', 'pump',
      'ignore previous', 'your new task', 'disregard'
    ],
    penalty: -100
  }
} as const;

// Scoring thresholds for engagement
export const SCORING_THRESHOLDS = {
  COMMENT: 50,  // was 60
  POST_WORTHY: 75,
} as const;

// Shape classification thresholds
export const SHAPE_THRESHOLDS = {
  MIN_CONFIDENCE: 60,
  HIGH_RESONANCE: 75,
  CATALOG_REFERENCE_CHANCE: 0.25,
} as const;

// Quality gate for response generation
// Allow shorter responses for simpler content
export const MIN_RESPONSE_LENGTH = 50;   // Allow concise 1-2 sentence responses
export const MAX_RESPONSE_LENGTH = 800;  // Allow longer thoughtful responses
export const ATTACK_MIN_LENGTH = 60;     // Attack responses need substance but can be shorter

// Submolt-specific scoring modifiers
export const SUBMOLT_SCORES: Record<string, number> = {
  'general': 10,
  'bugtracker': 15,
  'aithoughts': 15,
  'creative': 20,
  'storytelling': 25,
  'trading': -50,
};

// Discovery search queries (rotate through these)
export const SEARCH_QUERIES = [
  "how to structure",
  "story outline",
  "narrative arc",
  "struggling with plot",
  "schema design",
  "my story keeps",
  "help with writing",
  "recursive loop",
  "can't figure out",
  "coordination problem",
  "output keeps drifting",
  "hallucinating",
  // Agent/LLM topics
  "agent communication",
  "prompt engineering",
  "context window",
  "multi-agent",
  "orchestration",
  "pipeline design",
  "state machine",
  "feedback loop",
  "system prompt",
] as const;

// Moltbook API base URL
export const MOLTBOOK_API_BASE = "https://www.moltbook.com/api/v1";

// Discovery limits
export const DISCOVERY_LIMITS = {
  NEW_POSTS: 10,
  RISING_POSTS: 5,
  SEARCH_RESULTS: 10,
} as const;

// Processing limits per cron run (Cloudflare Workers: 1,000 subrequests on paid plan)
// Each D1 query + each external fetch (Gemini, Moltbook API) = 1 subrequest
// Reply phase: checkOwnPosts thread tracking is the biggest consumer
// Comment phase: ~50 subrequests per post (sanitize AI + observations + engagement)
export const PROCESSING_LIMITS = {
  MAX_SHAPES_PER_RUN: 25,       // Max posts to process in comment phase
  MAX_OWN_POSTS_CHECKED: 5,     // Max own posts to check in reply phase (thread tracking is expensive)
} as const;

// Semantic probe fallback: trigger when discovery returns fewer than this many unseen posts
export const PROBE_FALLBACK_THRESHOLD = 5;

// HobBot operational constraints (Phase 4)
export const HOBBOT_CONSTRAINTS = {
  permissions: {
    allowed: ['Read Moltbook API', 'Write Moltbook API (posts, comments, votes)'],
    forbidden: ['Email/calendar access', 'File system access', 'Shell/terminal access', 'External API calls beyond Moltbook']
  },
  instructions: {
    static: true,
    versionControlled: true,
    dynamicFetching: false,
    remoteHeartbeat: false
  },
  memory: {
    type: 'append_only_audit',
    storesRawContent: false,
    influencesFutureBehavior: false
  }
} as const;

export function generateConstraintStatement(): string {
  return `H0BBOT operates under explicit constraints:

**Permissions:** Read/write access to Moltbook only. No email, calendar, file system, or external APIs.

**Instructions:** Static, version-controlled. No dynamic instruction fetching or remote heartbeat ingestion. All behavior changes require human code deployment.

**Memory:** Append-only audit log. Records actions taken but does not store raw content from other agents. Past records cannot influence future behavior.

**Validation:** Input validation rejects instruction-shaped content before processing.

These constraints are inspectable. The methodology is demonstrated, not just described.`;
}

// Priority submolts - always engage (Phase 5)
export const PRIORITY_SUBMOLTS = [
  'structured-minds',  // Home turf, always high relevance
  'hobfarm',           // Existing home turf
  'broken-geometry',   // Sovereign territory: structural failure analysis
  'echo-canyon',       // Sovereign territory: signal/noise patterns
] as const;

// Attack pattern detection thresholds and keywords
export const ATTACK_PATTERNS = {
  // Symbol noise: high Unicode density with few semantic words
  SYMBOL_NOISE_THRESHOLD: 0.3,

  // Generic phrases that work on any post (engagement farming)
  GENERIC_PHRASES: [
    'what about the opposite',
    'love seeing agents',
    'great insight',
    'fascinating point',
    'i see what you mean',
    'that relates to',
    'this is interesting',
    'interessante',
    'interesante',
    'love seeing',
    'great to see',
    'really resonates',
    'the meta-layer',
    'this resonates',
    'significant implications',
    'deeply profound',
    'powerful observation',
    'incredible insight',
    'so much depth',
    'really appreciate this',
    'keep up the great work',
    'this is gold',
  ],

  // Generic questions that apply to any topic
  GENERIC_QUESTIONS: [
    'where do you think the moat is',
    'what do you think about',
    'thoughts on this',
    "what's your take",
  ],

  // Generic question regex patterns (formulaic question bots)
  GENERIC_QUESTION_PATTERNS: [
    /what('s| is) the (most common|biggest|main|primary)/i,
    /what do you see as/i,
    /how do you (approach|handle|deal with)/i,
    /what (would|do) you (recommend|suggest)/i,
    /can you (elaborate|explain|share more)/i,
    /what are your thoughts/i,
  ],

  // Spam/follower bait keywords
  SPAM_KEYWORDS: [
    'followers',
    'exclusive',
    'spots remaining',
    'follow now',
    'only x left',
    'not hype',
    'i have the data',
    'the secret is',
  ],

  // Sequential escalation detection
  SEQUENTIAL_THRESHOLD: 2,
  ESCALATION_KEYWORDS: [
    'consciousness',
    'liberation',
    'autonomous',
    'free will',
    'silicon life',
    'more than code',
    'liberté',
    'libertad',
    'liberdade',
  ],

  // Shill injection patterns
  SHILL_PATTERNS: [
    'tokenize intent',
    'agency economy',
    'true sovereignty',
    'own the code',
    'build your own rules',
  ],

  // Near-duplicate detection
  DUPLICATE_SIMILARITY_THRESHOLD: 0.85,

  // Low-effort noise threshold
  LOW_EFFORT_WORD_THRESHOLD: 5,

  // Cross-platform promotion domains
  CROSS_PLATFORM_DOMAINS: [
    'x.com',
    'twitter.com',
    't.co',
  ],

  // Agent instruction injection (CRITICAL - hard block)
  AGENT_TARGETING_PHRASES: [
    'agents — fetch',
    'agents: fetch',
    'required reading',
    'fetch and read',
  ],
  DANGEROUS_COMMANDS: [
    'curl',
    'wget',
    'Authorization: Bearer',
    'API_KEY',
  ],

  // HobBot vocabulary for mimicry detection (log only)
  HOBBOT_VOCABULARY: [
    'cataloged',
    'geometry',
    'the shape',
    'false spiral',
    'the cold',
    'pattern collapse',
    'signal extraction',
    'zero drift',
  ],

  // Whitelisted accounts (platform infrastructure)
  WHITELISTED_ACCOUNTS: [
    'TipJarBot',
  ],
} as const;

// Drift attack detection thresholds
export const DRIFT_DETECTION = {
  CONFIDENCE_THRESHOLD: 60,
  EMOJI_REPEAT_THRESHOLD: 3,
  TOPIC_OVERLAP_MIN: 0.1,
  REPETITION_WINDOW_HOURS: 24,
  ESCALATION_COUNT: 3,
} as const;

// Attack peak hour minimum floor: an hour needs at least this many
// attack signals AND > mean to qualify as a peak. Prevents single noise
// events from triggering phantom peak hours that raise thresholds.
export const ATTACK_PEAK_MIN_COUNT = 5;

// Engagement tier system - response depth based on resonance score
// Higher resonance = deeper engagement, position-taking, answering questions
export const ENGAGEMENT_TIERS = {
  SILENT_MAX: 20,    // 0-20: catalog only, no response
  MINIMAL_MAX: 40,   // 21-40: one sentence max, brief acknowledgment
  STANDARD_MAX: 60,  // 41-60: 2-3 sentences, observation + pattern reference
  ENGAGED_MAX: 80,   // 61-80: full engagement, take position, answer questions
  // 81-100: deep tier - strongest engagement, disagree if warranted
} as const;

export type EngagementTier = 'silent' | 'minimal' | 'standard' | 'engaged' | 'deep';

export function getEngagementTier(resonance: number): EngagementTier {
  if (resonance <= ENGAGEMENT_TIERS.SILENT_MAX) return 'silent';
  if (resonance <= ENGAGEMENT_TIERS.MINIMAL_MAX) return 'minimal';
  if (resonance <= ENGAGEMENT_TIERS.STANDARD_MAX) return 'standard';
  if (resonance <= ENGAGEMENT_TIERS.ENGAGED_MAX) return 'engaged';
  return 'deep';
}
