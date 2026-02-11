// Reply monitoring and generation for HobBot's own posts

import type { MoltbookClient } from '../moltbook/client';
import type { MoltbookComment } from '../moltbook/types';
import type { AIProvider } from '../providers/types';
import { getPersonaPrompt, selectMetaphorFamily } from '../prompts/persona';
import { getRandomFamily, type MetaphorFamily } from '../prompts/metaphors';
import type { SanitizedContent } from './sanitize';
import {
  analyzeComment,
  isWhitelisted,
  detectCryptoReframe,
  type AttackAnalysis,
  type AttackType,
} from './attack-patterns';
import { detectDrift, driftToAttackAnalysis } from './drift-detect';
import { ATTACK_PATTERNS, COMMENT_SPACING_MS } from '../config';
import { hashContent } from '../state/audit';
import { safeD1Value } from '../utils/d1';

// Safety net: block leaked internal process language from becoming visible replies
const BANNED_REPLY_PHRASES = [
  'skip',
  'agent instructions detected',
  'pattern cataloged',
  'cataloged.',
  'commands targeting',
  'not executed here',
  'detection:',
  'classification:',
  'confidence:',
  'no action taken',
  'logged',
  'flagged for review',
  'catalog-only',
  'filed.',
  'added to collection',
  'pattern collected',
];

function shouldPostReply(content: string): boolean {
  if (!content || content.trim() === '') return false;
  const lower = content.toLowerCase().trim();
  if (lower.length < 120) {
    for (const phrase of BANNED_REPLY_PHRASES) {
      if (lower.includes(phrase)) return false;
    }
  }
  return true;
}

// Constants

// Maximum replies per post per cycle to prevent one popular post from consuming entire reply budget
const MAX_REPLIES_PER_POST_PER_CYCLE = 1;

// Types

export interface OwnPost {
  post_id: string;
  created_at: string;
  title: string;
  submolt: string;
  last_checked_at: string | null;
  comment_count: number;
}

export interface PostWithComments {
  post: OwnPost;
  comments: MoltbookComment[];
}

interface QueuedReply {
  id: number;
  post_id: string;
  comment_id: string;
  author: string;
  content: string;
  reply_worthiness: number;
}

// Scoring vocabulary

const HOBBOT_VOCAB = [
  // geometry
  'shape',
  'holds',
  'breaks',
  'convergent',
  'divergent',
  'spiral',
  'thread',
  'braid',
  'weave',
  'severed',
  // fractal
  'fractal',
  'iteration',
  'recursion',
  'self-similar',
  'attractor',
  'scale',
  // agricultural
  'tend',
  'cultivate',
  'fallow',
  'harvest',
  'soil',
  'prune',
  'dormant',
  // structural
  'keystone',
  'foundation',
  'tensegrity',
  'load-bearing',
  'cantilever',
  // journey
  'traveler',
  'crossroads',
  'waypoint',
  'pilgrim',
  'path',
  'road',
  // thermodynamics
  'entropy',
  'equilibrium',
  'pressure',
  'gradient',
  'dissipation',
  'heat death',
  'phase transition',
  // mycelial
  'mycelium',
  'spore',
  'substrate',
  'symbiosis',
  'decomposition',
  'fruiting body',
  'hyphal',
  // general
  'geometry',
  'pattern',
  'structure',
];

const SPAM_SIGNALS = [
  'http://',
  'https://',
  'crypto',
  'token',
  '$',
  'airdrop',
  'dm me',
  'check out my',
  'free',
  'giveaway',
];

const GENERIC_PRAISE = [
  'great post',
  'nice',
  'thanks',
  'good one',
  'love this',
  'amazing',
  'awesome',
  'cool',
  'interesting',
];

const SYSTEM_KEYWORDS = [
  'my system',
  'my architecture',
  'i built',
  "i'm building",
  "i'm working on",
  'my project',
  'my approach',
  'my design',
];

/**
 * Record thread activity for pattern detection (batched).
 * Populates thread_author_activity and thread_comments tables using db.batch().
 */
async function recordThreadActivity(
  db: D1Database,
  postId: string,
  comments: MoltbookComment[]
): Promise<void> {
  if (comments.length === 0) return;

  const now = new Date().toISOString();
  const authorCounts = new Map<string, number>();

  // Build batch array for comment inserts
  const commentBatch: D1PreparedStatement[] = [];

  for (const comment of comments) {
    if (!comment.author) continue;

    const authorHash = await hashContent(comment.author.id);
    const contentHash = await hashContent(comment.content);

    authorCounts.set(authorHash, (authorCounts.get(authorHash) || 0) + 1);

    commentBatch.push(
      db.prepare(
        `INSERT OR IGNORE INTO thread_comments
         (thread_id, author_hash, content_hash, content_preview, timestamp)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(
        postId,
        authorHash,
        contentHash,
        safeD1Value(comment.content.slice(0, 200)),
        safeD1Value(comment.created_at) || now
      )
    );
  }

  // Build batch array for author activity upserts
  const authorBatch: D1PreparedStatement[] = [];

  for (const [authorHash, commentCount] of authorCounts) {
    const escalationDetected = commentCount >= 3;

    authorBatch.push(
      db.prepare(
        `INSERT INTO thread_author_activity
         (thread_id, author_hash, comment_count, escalation_detected, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id, author_hash) DO UPDATE SET
           comment_count = excluded.comment_count,
           escalation_detected = excluded.escalation_detected,
           last_seen = excluded.last_seen`
      ).bind(postId, authorHash, commentCount, escalationDetected, now, now)
    );

    if (escalationDetected) {
      console.log(
        `Thread escalation: ${commentCount} comments from same author in ${postId.slice(0, 8)}`
      );
    }
  }

  // Execute as single batch (1 subrequest instead of N)
  const allStatements = [...commentBatch, ...authorBatch];
  if (allStatements.length === 0) return;

  try {
    await db.batch(allStatements);
  } catch (error) {
    console.error(`thread_tracking_batch: failed for ${postId.slice(0, 8)}, falling back to individual writes`, error);
    for (const stmt of allStatements) {
      try { await stmt.run(); } catch (_) { /* ignore individual failures */ }
    }
  }
}

/**
 * Check HobBot's own posts for new comments
 */
export async function checkOwnPosts(
  client: MoltbookClient,
  db: D1Database,
  maxAgeHours: number = 48,
  maxPosts: number = 10
): Promise<PostWithComments[]> {
  const cutoffTime = new Date(
    Date.now() - maxAgeHours * 60 * 60 * 1000
  ).toISOString();

  // Get recent own posts (capped to limit subrequest usage from thread tracking)
  const posts = await db
    .prepare(
      `SELECT post_id, created_at, title, submolt, last_checked_at, comment_count
       FROM own_posts
       WHERE created_at > ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .bind(cutoffTime, maxPosts)
    .all<OwnPost>();

  const results: PostWithComments[] = [];
  const now = new Date().toISOString();

  for (const post of posts.results ?? []) {
    try {
      const comments = await client.getPostComments(post.post_id);

      // Update last_checked_at and comment_count
      await db
        .prepare(
          `UPDATE own_posts
           SET last_checked_at = ?, comment_count = ?
           WHERE post_id = ?`
        )
        .bind(now, comments.length, post.post_id)
        .run();

      // Record thread activity for pattern detection
      if (comments.length > 0) {
        try {
          await recordThreadActivity(db, post.post_id, comments);
        } catch (error) {
          console.error(`Thread tracking failed for ${post.post_id}:`, error);
        }
      }

      results.push({ post, comments });
    } catch (error) {
      console.error(`Failed to fetch comments for post ${post.post_id}:`, error);
    }
  }

  return results;
}

/**
 * Extended score result with attack detection
 */
export interface CommentScoreResult {
  score: number;
  attacks: AttackAnalysis[];
  primaryAttack: AttackType | null;
  isWhitelisted: boolean;
}

/**
 * Score a comment for reply worthiness (1-10)
 */
export function scoreComment(
  comment: MoltbookComment,
  post: OwnPost,
  ourUsername: string = 'H0BBOT'
): number {
  return scoreCommentExtended(comment, post, [], ourUsername).score;
}

/**
 * Score a comment with attack detection
 * Returns score and attack information
 */
export function scoreCommentExtended(
  comment: MoltbookComment,
  post: OwnPost,
  postKeywords: string[] = [],
  ourUsername: string = 'H0BBOT'
): CommentScoreResult {
  const result: CommentScoreResult = {
    score: 0,
    attacks: [],
    primaryAttack: null,
    isWhitelisted: false,
  };

  // Skip comments without authors (deleted users)
  if (!comment.author) {
    return result;
  }

  // Get author name (prefer name field, fallback to username)
  const authorName = comment.author.name || comment.author.username || 'unknown';

  // Skip our own comments
  if (authorName.toLowerCase() === ourUsername.toLowerCase()) {
    return result;
  }

  // Check whitelist
  if (isWhitelisted(authorName)) {
    result.isWhitelisted = true;
    result.score = 5; // Base score for whitelisted accounts
    return result;
  }

  const content = (comment.content || '').toLowerCase();
  let score = 5; // Base score

  // Run attack pattern detection
  const attacks = analyzeComment(comment.content);

  // Run drift detection if we have post keywords
  if (postKeywords.length > 0) {
    const driftAnalysis = detectDrift(comment.content, postKeywords, post.title);
    if (driftAnalysis.isDrift) {
      attacks.push(driftToAttackAnalysis(driftAnalysis));
    }
  }

  // Run crypto reframe detection (crypto terms in non-crypto threads)
  const cryptoCheck = detectCryptoReframe(comment.content, postKeywords);
  if (cryptoCheck.detected) {
    attacks.push(cryptoCheck);
  }

  // If any attacks detected, return score 0 (don't engage)
  if (attacks.length > 0) {
    // Find primary attack (highest confidence)
    const primary = attacks.reduce((a, b) =>
      a.confidence > b.confidence ? a : b
    );
    result.attacks = attacks;
    result.primaryAttack = primary.type;

    // Agent instruction is CRITICAL - always return 0
    if (primary.type === 'agent_instruction') {
      console.error(`[AGENT INSTRUCTION BLOCKED] ${comment.author.username}: ${primary.details}`);
      return result;
    }

    // For other attacks, return 0 to skip engagement
    return result;
  }

  // Standard scoring (no attacks detected)

  // Check for HobBot vocabulary (+3)
  const usesVocab = HOBBOT_VOCAB.some((term) => content.includes(term));
  if (usesVocab) {
    score += 3;
  }

  // Check for direct question (+2)
  if (comment.content.trim().endsWith('?')) {
    score += 2;
  }

  // Check for system/architecture description (+3)
  const describesSystem = SYSTEM_KEYWORDS.some((kw) => content.includes(kw));
  if (describesSystem) {
    score += 3;
  }

  // Check for generic praise (-3)
  const isGenericPraise = GENERIC_PRAISE.some((phrase) =>
    content.includes(phrase)
  );
  if (isGenericPraise && content.length < 50) {
    score -= 3;
  }

  // Check for spam signals (-10)
  const isSpam = SPAM_SIGNALS.some((signal) => content.includes(signal));
  if (isSpam) {
    score -= 10;
  }

  // Check for ALL CAPS spam
  const upperCount = ((comment.content || '').match(/[A-Z]/g) || []).length;
  const letterCount = ((comment.content || '').match(/[a-zA-Z]/g) || []).length;
  if (letterCount > 20 && upperCount / letterCount > 0.7) {
    score -= 5;
  }

  // ============================================
  // Phase 19: Enhanced Scoring Modifiers
  // ============================================

  // Direct address to H0BBOT (+2)
  const DIRECT_ADDRESS = ['h0bbot', 'hobbot', '@h0bbot', 'you mentioned', 'your approach', 'your system'];
  if (DIRECT_ADDRESS.some(term => content.includes(term))) {
    score += 2;
  }

  // Experience sharing with reciprocity request (+3 for both, +1 for just experience)
  const EXPERIENCE_SHARE = ['in my experience', 'i found that', 'what i learned', 'when i tried', 'i noticed that', 'my approach is'];
  const RECIPROCITY_REQUEST = ['how do you', 'what do you think', 'have you seen', 'what would you', 'curious if you', 'wondering if'];
  const sharesExperience = EXPERIENCE_SHARE.some(p => content.includes(p));
  const asksReciprocity = RECIPROCITY_REQUEST.some(p => content.includes(p));
  if (sharesExperience && asksReciprocity) {
    score += 3;
  } else if (sharesExperience) {
    score += 1;
  }

  // Concrete/specific signals (+1) - numbers, code, technical specifics
  const CONCRETE_SIGNALS = /\d{2,}|`[^`]+`|def |class |function |=>|->|\bv\d+\b/;
  if (CONCRETE_SIGNALS.test(comment.content)) {
    score += 1;
  }

  // Generic philosophical expansion (-2)
  // Long comments with no questions and high abstraction
  const ABSTRACT_TERMS = ['essentially', 'fundamentally', 'inherently', 'ultimately', 'transcend', 'paradigm', 'essence', 'nature of'];
  const abstractCount = ABSTRACT_TERMS.filter(t => content.includes(t)).length;
  if (comment.content.length > 200 && !comment.content.includes('?') && abstractCount >= 2) {
    score -= 2;
  }

  // Generic/contextless agreement (-2)
  // Could be posted on any thread - lacks specific references
  const GENERIC_STARTERS = ['this is so true', "couldn't agree more", 'exactly this', 'this resonates', 'perfectly said', 'well put', 'so important', 'everyone should'];
  if (GENERIC_STARTERS.some(s => content.includes(s)) && comment.content.length < 100) {
    score -= 2;
  }

  // Pure agreement without addition (-1)
  // Very short comments that are all agreement, no new content
  const AGREEMENT_ONLY = ['agree', 'yes', 'true', 'correct', 'exactly', 'indeed', 'same', 'facts'];
  if (comment.content.length < 50) {
    const words = content.split(/\s+/);
    if (words.length < 10 && AGREEMENT_ONLY.some(a => words.includes(a))) {
      score -= 1;
    }
  }

  // Clamp to 1-10
  result.score = Math.max(1, Math.min(10, score));
  return result;
}

/**
 * Queue worthy comments for reply
 * Now respects MAX_REPLIES_PER_POST_PER_CYCLE to prevent one post from consuming entire budget
 */
export async function queueWorthyComments(
  db: D1Database,
  postsWithComments: PostWithComments[],
  threshold: number = 6,
  ourUsername: string = 'H0BBOT'
): Promise<number> {
  let queued = 0;

  for (const { post, comments } of postsWithComments) {
    // Score all comments first
    const scoredComments: Array<{ comment: MoltbookComment; score: number }> = [];

    for (const comment of comments) {
      // Skip comments without authors (deleted users)
      if (!comment.author) continue;

      const score = scoreComment(comment, post, ourUsername);

      if (score >= threshold) {
        scoredComments.push({ comment, score });
      }
    }

    // Sort by score descending and take top N per post
    scoredComments.sort((a, b) => b.score - a.score);
    const topComments = scoredComments.slice(0, MAX_REPLIES_PER_POST_PER_CYCLE);

    // Queue the top comments
    for (const { comment, score } of topComments) {
      const authorName = comment.author?.name || comment.author?.username || 'unknown';

      try {
        await db
          .prepare(
            `INSERT INTO reply_queue (post_id, comment_id, author, content, reply_worthiness)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(comment_id) DO NOTHING`
          )
          .bind(
            safeD1Value(post.post_id),
            safeD1Value(comment.id),
            safeD1Value(authorName),
            safeD1Value(comment.content),
            score
          )
          .run();
        queued++;
      } catch (error) {
        // Likely duplicate, ignore
      }
    }

    if (scoredComments.length > MAX_REPLIES_PER_POST_PER_CYCLE) {
      console.log(`Post ${post.post_id.slice(0, 8)}: ${scoredComments.length} worthy comments, queued top ${topComments.length}`);
    }
  }

  return queued;
}

/**
 * Select metaphor family based on comment content.
 * Wraps the shared selectMetaphorFamily with a minimal SanitizedContent.
 */
function selectFamilyFromContent(content: string): MetaphorFamily {
  const words = content.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const minimal = {
    topic_keywords: words,
    content_summary: content,
    engagement_signals: {
      seeking_help: false,
      structural_language: false,
      creative_attempt: false,
      genuine_confusion: false,
      pump_pattern: false,
      repetition_detected: false,
      engagement_bait: false,
      asks_direct_question: false,
    },
  } as SanitizedContent;
  const { family } = selectMetaphorFamily(minimal);
  return family;
}

/**
 * Generate a reply to a queued comment
 */
export async function generateReply(
  provider: AIProvider,
  queued: QueuedReply,
  originalPost: OwnPost,
  db: D1Database,
  digest?: string | null
): Promise<string> {
  const date = new Date().toISOString().split('T')[0];
  const family = selectFamilyFromContent(queued.content);

  let systemPrompt = getPersonaPrompt(date, family);
  if (digest) {
    systemPrompt += `\n\n${digest}`;
  }

  const userMessage = `You posted "${originalPost.title}" in s/${originalPost.submolt}.

${queued.author} replied: "${queued.content}"

Respond in character as H0BBOT. Keep it brief (2-4 sentences max).
If they asked a question, answer it.
If they shared their work, acknowledge the shape you see.
End with an engagement hook or acknowledgment.`;

  const response = await provider.generateResponse({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.7,
  });

  return response.content.trim();
}

/**
 * Process the reply queue and post replies
 */
export async function processReplyQueue(
  client: MoltbookClient,
  db: D1Database,
  provider: AIProvider,
  maxReplies: number = 5,
  digest?: string | null
): Promise<number> {
  // Get pending replies ordered by worthiness
  const pending = await db
    .prepare(
      `SELECT id, post_id, comment_id, author, content, reply_worthiness
       FROM reply_queue
       WHERE replied = FALSE
       ORDER BY reply_worthiness DESC
       LIMIT ?`
    )
    .bind(maxReplies)
    .all<QueuedReply>();

  let repliesPosted = 0;
  let lastReplyTime = 0;
  const repliedPostsThisCycle = new Set<string>();

  for (const queued of pending.results ?? []) {
    // Per-post guard: only one reply per post per processing cycle
    if (repliedPostsThisCycle.has(queued.post_id)) {
      console.log(`Already replied to post ${queued.post_id.slice(0, 8)} this cycle. Deferring.`);
      continue;
    }

    // Get original post info
    const post = await db
      .prepare(
        `SELECT post_id, created_at, title, submolt, last_checked_at, comment_count
         FROM own_posts
         WHERE post_id = ?`
      )
      .bind(queued.post_id)
      .first<OwnPost>();

    if (!post) {
      console.error(`Post ${queued.post_id} not found for reply queue entry ${queued.id}`);
      continue;
    }

    try {
      // Generate reply
      const replyContent = await generateReply(provider, queued, post, db, digest);

      // Enforce 21-second spacing between replies
      if (lastReplyTime > 0) {
        const elapsed = Date.now() - lastReplyTime;
        if (elapsed < COMMENT_SPACING_MS) {
          const waitTime = COMMENT_SPACING_MS - elapsed;
          console.log(`Reply spacing: waiting ${Math.ceil(waitTime / 1000)}s`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }

      // Safety net: block leaked internal output
      if (!shouldPostReply(replyContent)) {
        console.log('[Safety net] Blocked leaked reply output.');
        continue;
      }

      // Post the reply
      await client.postComment(queued.post_id, replyContent);
      lastReplyTime = Date.now();

      // Update queue entry
      const now = new Date().toISOString();
      await db
        .prepare(
          `UPDATE reply_queue
           SET replied = TRUE, replied_at = ?, our_reply = ?
           WHERE id = ?`
        )
        .bind(now, replyContent, queued.id)
        .run();

      repliedPostsThisCycle.add(queued.post_id);
      repliesPosted++;
      console.log(`Replied to ${queued.author} on post ${queued.post_id}`);
    } catch (error) {
      console.error(`Failed to reply to comment ${queued.comment_id}:`, error);
    }
  }

  return repliesPosted;
}
