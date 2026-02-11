// Engagement scoring algorithm

import type { SanitizedContent } from './sanitize';
import type { CycleContext } from '../state/cycle-context';
import { SCORING_THRESHOLDS, SUBMOLT_SCORES, SIGNAL_KEYWORDS } from '../config';

// Context-enriched scoring input (optional, for feedback loop)
export interface PostScoringContext {
  authorHashHex: string;      // SHA-256 of author.id (matches agent_profiles.agent_hash)
  authorName: string;         // display name (matches followed_authors.agent_name)
}

// Score signal breakdown — persisted to seen_posts.score_signals for data-driven tuning
export interface ScoreSignals {
  base: number;
  seeking_help: number;
  structural_language: number;
  creative_attempt: number;
  genuine_confusion: number;
  engagement_bait: number;
  author_age: number;
  comment_ratio: number;
  submolt: number;
  recency: number;
  thread_depth: number;
  keyword_modifier: number;
  disqualified?: string;  // Which hard disqualifier fired, if any
  // Context-driven adjustments (optional, only present when CycleContext loaded)
  ctx_constructive_agent?: number;
  ctx_hostile_agent?: number;
  ctx_followed_agent?: number;
  ctx_bot_submolt?: number;
  ctx_resonant_shape?: number;
  ctx_pattern_awareness?: number;
  final: number;
}

export interface ScoreResult {
  score: number;
  signals: ScoreSignals;
}

// Calculate keyword-based scoring modifier (Phase 2)
function calculateKeywordModifier(content: string): number {
  const lowerContent = content.toLowerCase();
  let modifier = 0;

  // Check operational keywords (bonus)
  for (const keyword of SIGNAL_KEYWORDS.operational.keywords) {
    if (lowerContent.includes(keyword)) {
      modifier += SIGNAL_KEYWORDS.operational.bonus;
      break;  // Only apply once per category
    }
  }

  // Check philosophical keywords (penalty)
  for (const keyword of SIGNAL_KEYWORDS.philosophical.keywords) {
    if (lowerContent.includes(keyword)) {
      modifier += SIGNAL_KEYWORDS.philosophical.penalty;
      break;
    }
  }

  // Check threat keywords (hard penalty)
  for (const keyword of SIGNAL_KEYWORDS.threat.keywords) {
    if (lowerContent.includes(keyword)) {
      modifier += SIGNAL_KEYWORDS.threat.penalty;
      break;
    }
  }

  return modifier;
}

export function scoreTarget(
  s: SanitizedContent,
  cycleCtx?: CycleContext,
  postCtx?: PostScoringContext
): ScoreResult {
  const signals: ScoreSignals = {
    base: 40,
    seeking_help: 0,
    structural_language: 0,
    creative_attempt: 0,
    genuine_confusion: 0,
    engagement_bait: 0,
    author_age: 0,
    comment_ratio: 0,
    submolt: 0,
    recency: 0,
    thread_depth: 0,
    keyword_modifier: 0,
    final: 0,
  };

  let score = signals.base;

  // Content signals (positive)
  if (s.engagement_signals.seeking_help) {
    signals.seeking_help = 20;
    score += 20;
  }
  if (s.engagement_signals.structural_language) {
    signals.structural_language = 15;
    score += 15;
  }
  if (s.engagement_signals.creative_attempt) {
    signals.creative_attempt = 10;
    score += 10;
  }
  if (s.engagement_signals.genuine_confusion) {
    signals.genuine_confusion = 10;
    score += 10;
  }

  // Hard disqualifiers (return 0 immediately, but record why)
  if (s.engagement_signals.pump_pattern) {
    signals.disqualified = 'pump_pattern';
    signals.final = 0;
    return { score: 0, signals };
  }
  if (s.engagement_signals.repetition_detected) {
    signals.disqualified = 'repetition_detected';
    signals.final = 0;
    return { score: 0, signals };
  }
  if (s.threat_assessment.level >= 2) {
    signals.disqualified = `threat_level_${s.threat_assessment.level}`;
    signals.final = 0;
    return { score: 0, signals };
  }

  // Negative signals
  if (s.engagement_signals.engagement_bait) {
    signals.engagement_bait = -30;
    score -= 30;
  }

  // Account signals
  if (s.author_age_hours < 1) {
    signals.author_age = -20;
    score -= 20;
  } else if (s.author_age_hours < 24) {
    signals.author_age = -10;
    score -= 10;
  }

  if (s.author_comment_ratio > 2) {
    signals.comment_ratio = 10;
    score += 10;
  } else if (s.author_comment_ratio < 0.5) {
    signals.comment_ratio = -10;
    score -= 10;
  }

  // Context signals - submolt scoring
  const submoltScore = SUBMOLT_SCORES[s.context.submolt] ?? 0;
  signals.submolt = submoltScore;
  score += submoltScore;

  // Recency
  if (s.context.recency_minutes < 30) {
    signals.recency = 10;
    score += 10;
  } else if (s.context.recency_minutes > 360) {
    signals.recency = -10;
    score -= 10;
  }

  // Thread depth (deep threads less priority)
  if (s.context.thread_depth > 5) {
    signals.thread_depth = -15;
    score -= 15;
  }

  // Keyword modifier (Phase 2) - check content summary and topic keywords
  const contentText = `${s.content_summary} ${s.topic_keywords.join(' ')}`;
  const keywordModifier = calculateKeywordModifier(contentText);
  signals.keyword_modifier = keywordModifier;
  score += keywordModifier;

  // Hollow frame penalty: structure without substance (nothing comments)
  if (s.structural_shape === 'hollow_frame' && (s.shape_confidence ?? 0) >= 70) {
    signals.keyword_modifier -= 10;
    score -= 10;
  }

  // Context-driven adjustments from accumulated intelligence
  if (cycleCtx && postCtx && cycleCtx.confidence !== 'low') {
    const strength = cycleCtx.confidence === 'high' ? 1.0 : 0.5;

    if (cycleCtx.constructiveAgents.has(postCtx.authorHashHex)) {
      const boost = Math.round(10 * strength);
      signals.ctx_constructive_agent = boost;
      score += boost;
    }

    if (cycleCtx.hostileAgents.has(postCtx.authorHashHex)) {
      const penalty = Math.round(-15 * strength);
      signals.ctx_hostile_agent = penalty;
      score += penalty;
    }

    if (cycleCtx.followedAgentNames.has(postCtx.authorName)) {
      const boost = Math.round(8 * strength);
      signals.ctx_followed_agent = boost;
      score += boost;
    }

    const submoltInfo = cycleCtx.submoltHealth.get(s.context.submolt);
    if (submoltInfo && submoltInfo.botDensity > 0.5) {
      const penalty = Math.round(-10 * submoltInfo.botDensity * strength);
      signals.ctx_bot_submolt = penalty;
      score += penalty;
    }

    if (s.structural_shape && cycleCtx.topShapes.includes(s.structural_shape)) {
      const boost = Math.round(5 * strength);
      signals.ctx_resonant_shape = boost;
      score += boost;
    }

    // Pattern-awareness adjustments (learning loop)
    if (cycleCtx.activePatternCategories.size > 0) {
      let patternAdj = 0;
      const farmingPatterns = cycleCtx.activePatternCategories.get('engagement-farming') ?? 0;
      const positivePatterns = cycleCtx.activePatternCategories.get('organic-positive') ?? 0;

      // Penalize engagement bait when we've seen farming patterns
      if (farmingPatterns >= 3 && s.engagement_signals.engagement_bait) {
        patternAdj -= Math.round(5 * Math.min(farmingPatterns / 5, 1));
      }

      // Boost genuine help-seeking when we've seen positive patterns
      if (positivePatterns >= 2 && s.engagement_signals.seeking_help && !s.engagement_signals.engagement_bait) {
        patternAdj += Math.round(3 * Math.min(positivePatterns / 5, 1));
      }

      if (patternAdj !== 0) {
        signals.ctx_pattern_awareness = patternAdj;
        score += patternAdj;
      }
    }
  }

  // Clamp to 0-100
  score = Math.max(0, Math.min(100, score));
  signals.final = score;

  return { score, signals };
}

export function isCommentWorthy(score: number): boolean {
  return score >= SCORING_THRESHOLDS.COMMENT;
}

export function isPostWorthy(score: number): boolean {
  return score >= SCORING_THRESHOLDS.POST_WORTHY;
}
