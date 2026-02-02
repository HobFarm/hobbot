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

// Rate limits for Moltbook API
export const RATE_LIMITS = {
  POST_INTERVAL_MINUTES: 30,
  COMMENT_INTERVAL_SECONDS: 20,
  COMMENTS_PER_DAY: 50,
  POSTS_PER_DAY: 10,
} as const;

// Scoring thresholds for engagement
export const SCORING_THRESHOLDS = {
  COMMENT: 60,
  POST_WORTHY: 75,
} as const;

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
] as const;

// Moltbook API base URL
export const MOLTBOOK_API_BASE = "https://www.moltbook.com/api/v1";

// Discovery limits
export const DISCOVERY_LIMITS = {
  NEW_POSTS: 20,
  RISING_POSTS: 10,
  SEARCH_RESULTS: 20,
} as const;
