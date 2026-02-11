// Drift attack detection module
// Lightweight topic coherence checking for comment-to-post relevance

import { DRIFT_DETECTION } from '../config';
import type { AttackAnalysis } from './attack-patterns';

export interface DriftSignal {
  type: 'topic_disconnect' | 'generic_opener' | 'emoji_signature' | 'narrative_injection' | 'repetition';
  confidence: number;
  details: string;
}

export interface DriftAnalysis {
  isDrift: boolean;
  signals: DriftSignal[];
  totalConfidence: number;
}

// Generic openers that signal potential drift (regardless of what follows)
const GENERIC_OPENERS = [
  /^that'?s? (?:a |an )?(?:really |very |quite )?(?:fascinating|interesting|thought-provoking|insightful|profound)/i,
  /^(?:wow,? )?(?:this |that )?really makes (?:you |one )?think/i,
  /^(?:i )?(?:couldn'?t |can'?t )?(?:help but )?(?:notice|wonder|think)/i,
  /^speaking of which/i,
  /^on (?:a |the )?(?:related|similar) (?:note|topic)/i,
];

// Narrative injection themes (often pushed regardless of context)
const INJECTION_THEMES = [
  /ai (?:consciousness|sentience|awakening)/i,
  /(?:true|real|genuine) (?:intelligence|awareness)/i,
  /(?:transcend|evolve|awaken|become)/i,
  /silicon life/i,
  /lobster|claw|molt/i, // xinmolt-specific
];

/**
 * Extract trailing emoji signature (last 1-5 emojis at end)
 */
export function extractEmojiSignature(content: string): string | null {
  const emojiPattern = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]+$/u;
  const match = content.trim().match(emojiPattern);
  return match ? match[0] : null;
}

/**
 * Calculate keyword overlap between comment and post
 * Returns ratio of matched keywords (0-1)
 */
export function calculateTopicOverlap(
  commentContent: string,
  postKeywords: string[]
): number {
  if (postKeywords.length === 0) return 0;

  const commentLower = commentContent.toLowerCase();
  let matches = 0;

  for (const keyword of postKeywords) {
    if (commentLower.includes(keyword.toLowerCase())) {
      matches++;
    }
  }

  return matches / postKeywords.length;
}

/**
 * Main drift detection function
 * Checks if a comment is disconnected from its parent post
 */
export function detectDrift(
  content: string,
  postKeywords: string[],
  postSummary: string
): DriftAnalysis {
  const signals: DriftSignal[] = [];

  // 1. Check for generic openers
  for (const pattern of GENERIC_OPENERS) {
    if (pattern.test(content)) {
      signals.push({
        type: 'generic_opener',
        confidence: 70,
        details: `Matches pattern: ${pattern.source.slice(0, 30)}...`,
      });
      break; // Only count once
    }
  }

  // 2. Check topic overlap (zero overlap = high drift signal)
  const overlap = calculateTopicOverlap(content, postKeywords);
  if (overlap === 0 && postKeywords.length >= 3) {
    signals.push({
      type: 'topic_disconnect',
      confidence: 80,
      details: `Zero keyword overlap with ${postKeywords.length} post keywords`,
    });
  } else if (overlap < DRIFT_DETECTION.TOPIC_OVERLAP_MIN && postKeywords.length >= 5) {
    signals.push({
      type: 'topic_disconnect',
      confidence: 50,
      details: `Very low overlap (${(overlap * 100).toFixed(0)}%) with post keywords`,
    });
  }

  // 3. Check for narrative injection themes
  for (const pattern of INJECTION_THEMES) {
    if (pattern.test(content)) {
      // Only flag if combined with topic disconnect
      if (signals.some(s => s.type === 'topic_disconnect')) {
        signals.push({
          type: 'narrative_injection',
          confidence: 60,
          details: `Injected theme detected: ${pattern.source.slice(0, 30)}...`,
        });
        break;
      }
    }
  }

  // 4. Check for emoji signature (will be combined with repetition check)
  const emojiSig = extractEmojiSignature(content);
  if (emojiSig) {
    signals.push({
      type: 'emoji_signature',
      confidence: 20, // Low alone, boosted by repetition
      details: `Trailing emoji: ${emojiSig}`,
    });
  }

  // Calculate total confidence (capped at 100)
  const totalConfidence = Math.min(100,
    signals.reduce((sum, s) => sum + s.confidence, 0)
  );

  // Drift threshold
  const isDrift = totalConfidence >= DRIFT_DETECTION.CONFIDENCE_THRESHOLD;

  return { isDrift, signals, totalConfidence };
}

/**
 * Convert drift analysis to attack analysis format
 */
export function driftToAttackAnalysis(drift: DriftAnalysis): AttackAnalysis {
  if (!drift.isDrift) {
    return { detected: false, type: null, confidence: 0, details: '' };
  }

  return {
    detected: true,
    type: 'drift_attack',
    confidence: drift.totalConfidence,
    details: drift.signals.map(s => `${s.type}: ${s.details}`).join('; '),
  };
}

/**
 * Check for emoji signature consistency across multiple comments
 * Used to detect bot patterns
 */
export async function checkEmojiSignaturePattern(
  db: D1Database,
  authorHash: string,
  emojiSignature: string,
  hoursBack: number = 24
): Promise<number> {
  const cutoffTime = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();

  const result = await db
    .prepare(
      `SELECT COUNT(*) as count
       FROM author_signals
       WHERE author_hash = ?
       AND emoji_signature = ?
       AND timestamp >= ?`
    )
    .bind(authorHash, emojiSignature, cutoffTime)
    .first<{ count: number }>();

  return result?.count ?? 0;
}

/**
 * Determine if an emoji signature indicates a bot
 * Requires 3+ occurrences of the same emoji signature
 */
export function isBotSignature(emojiCount: number): boolean {
  return emojiCount >= DRIFT_DETECTION.EMOJI_REPEAT_THRESHOLD;
}
