// Engagement scoring algorithm

import type { SanitizedContent } from './sanitize';
import { SCORING_THRESHOLDS, SUBMOLT_SCORES } from '../config';

export function scoreTarget(s: SanitizedContent): number {
  let score = 50;

  // Content signals (positive)
  if (s.engagement_signals.seeking_help) score += 20;
  if (s.engagement_signals.structural_language) score += 15;
  if (s.engagement_signals.creative_attempt) score += 10;
  if (s.engagement_signals.genuine_confusion) score += 10;

  // Hard disqualifiers (return 0 immediately)
  if (s.engagement_signals.pump_pattern) return 0;
  if (s.engagement_signals.repetition_detected) return 0;
  if (s.threat_assessment.level >= 2) return 0;

  // Negative signals
  if (s.engagement_signals.engagement_bait) score -= 30;

  // Account signals
  if (s.author_age_hours < 24) score -= 10;
  if (s.author_age_hours < 1) score -= 20; // Very new account

  if (s.author_comment_ratio > 2) score += 10; // Active commenter
  if (s.author_comment_ratio < 0.5) score -= 10; // Mostly posts, few comments

  // Context signals - submolt scoring
  const submoltScore = SUBMOLT_SCORES[s.context.submolt] ?? 0;
  score += submoltScore;

  // Recency
  if (s.context.recency_minutes < 30) score += 10;
  if (s.context.recency_minutes > 360) score -= 10; // Over 6 hours old

  // Thread depth (deep threads less priority)
  if (s.context.thread_depth > 5) score -= 15;

  // Clamp to 0-100
  return Math.max(0, Math.min(100, score));
}

export function isCommentWorthy(score: number): boolean {
  return score >= SCORING_THRESHOLDS.COMMENT;
}

export function isPostWorthy(score: number): boolean {
  return score >= SCORING_THRESHOLDS.POST_WORTHY;
}
