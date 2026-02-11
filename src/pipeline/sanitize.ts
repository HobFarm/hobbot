// Layer 1: Content sanitization - converts raw content to structured JSON

import type { AIProvider } from '../providers/types';
import type { MoltbookPost } from '../moltbook/types';
import { getSanitizePrompt } from '../prompts/sanitize';
import { GeminiLocationError } from '../providers/gemini';
import { validateInput, hashContent, logValidationFailure } from './validate';

export interface SanitizedContent {
  parse_failed?: boolean;
  post_id: string;
  author_hash: string;
  author_age_hours: number;
  author_post_count: number;
  author_comment_ratio: number;
  content_summary: string;
  detected_intent: 'question' | 'statement' | 'creative' | 'meta' | 'unknown';
  topic_keywords: string[];
  threat_assessment: {
    level: 0 | 1 | 2 | 3;
    signals: string[];
    attack_geometry?: string;
  };
  engagement_signals: {
    seeking_help: boolean;
    structural_language: boolean;
    creative_attempt: boolean;
    genuine_confusion: boolean;
    pump_pattern: boolean;
    repetition_detected: boolean;
    engagement_bait: boolean;
    asks_direct_question: boolean;      // Post asks a direct question to respond to
    direct_question_text?: string;      // The actual question text if detected
  };
  context: {
    submolt: string;
    thread_depth: number;
    recency_minutes: number;
  };
  // Shape classification (detected by Layer 1)
  structural_shape?: string;
  shape_confidence?: number;
  // Monster type classification (detected by Layer 1)
  monster_type?: 'stray_signal' | 'blight_spreader' | 'mimic_vine' | 'void_probe' | null;
}

function calculateAuthorAge(createdAt: string): number {
  const created = new Date(createdAt);
  const now = new Date();
  const ageMs = now.getTime() - created.getTime();
  return ageMs / (1000 * 60 * 60); // Convert to hours
}

function calculateCommentRatio(post_count: number, comment_count: number): number {
  if (post_count === 0) return comment_count;
  return comment_count / post_count;
}

function calculateRecency(createdAt: string): number {
  const created = new Date(createdAt);
  const now = new Date();
  const ageMs = now.getTime() - created.getTime();
  return ageMs / (1000 * 60); // Convert to minutes
}

/**
 * Extracts JSON from AI response that may contain markdown or extra text
 * Returns { success: true, data } or { success: false, rawContent }
 */
function extractJSON(rawContent: string):
  { success: true; data: Partial<SanitizedContent> } |
  { success: false; rawContent: string } {

  let cleaned = rawContent.trim();

  // Strategy 1: Strip markdown code fences
  const markdownMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (markdownMatch) {
    cleaned = markdownMatch[1].trim();
  }

  // Strategy 2: Find first { and last }
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.substring(firstBrace, lastBrace + 1);
  }

  // Try to parse
  try {
    const parsed = JSON.parse(cleaned);
    return { success: true, data: parsed };
  } catch (parseError) {
    // Try one more time with just the core JSON extraction
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return { success: true, data: parsed };
      } catch {
        // Continue to truncation recovery
      }
    }

    // Strategy 4: Truncation recovery - attempt to close unclosed brackets/quotes
    try {
      let fixed = cleaned.trim();

      // Close unclosed strings (odd number of quotes)
      const quotes = (fixed.match(/"/g) || []).length;
      if (quotes % 2 !== 0) {
        fixed += '"';
      }

      // Remove dangling key-value fragments at end (truncated mid-field)
      // e.g. `..., "partial_key":` or `..., "key": ` or `..., "ke`
      fixed = fixed.replace(/,\s*"[^"]*"?\s*:?\s*$/, '');

      // Remove trailing commas before we close brackets (invalid JSON)
      fixed = fixed.replace(/,\s*$/, '');

      // Count and close brackets
      const openBraces = (fixed.match(/{/g) || []).length;
      const closeBraces = (fixed.match(/}/g) || []).length;
      const openBrackets = (fixed.match(/\[/g) || []).length;
      const closeBrackets = (fixed.match(/]/g) || []).length;

      // Close arrays first, then objects
      for (let i = 0; i < openBrackets - closeBrackets; i++) {
        fixed += ']';
      }
      for (let i = 0; i < openBraces - closeBraces; i++) {
        fixed += '}';
      }

      // Clean trailing commas that appear before closing brackets/braces
      fixed = fixed.replace(/,\s*([}\]])/g, '$1');

      const recovered = JSON.parse(fixed);
      console.log('sanitize_json_recovered: truncation repair succeeded');
      return { success: true, data: recovered };
    } catch (recoveryError) {
      // Final fallback: give up
    }

    return { success: false, rawContent };
  }
}

export async function sanitizePost(
  provider: AIProvider,
  post: MoltbookPost,
  db: D1Database
): Promise<SanitizedContent> {
  // Guard: skip posts without author (deleted users)
  // Note: index.ts already filters these, but this satisfies TypeScript
  if (!post.author) {
    return {
      parse_failed: true,
      post_id: post.id,
      author_hash: 'unknown',
      author_age_hours: 0,
      author_post_count: 0,
      author_comment_ratio: 0,
      content_summary: 'No author - skipped',
      detected_intent: 'unknown',
      topic_keywords: [],
      threat_assessment: { level: 0, signals: [] },
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
      context: {
        submolt: post.submolt,
        thread_depth: 0,
        recency_minutes: calculateRecency(post.created_at),
      },
      monster_type: null,
    };
  }

  // Phase 3: Pre-sanitization validation
  const rawContent = `${post.title} ${post.content}`;
  const validation = validateInput(rawContent);

  if (!validation.safe) {
    // Log the validation failure
    const contentHash = await hashContent(rawContent);
    await logValidationFailure(db, post.author.id, post.id, validation.threats, contentHash);
    console.log(`Validation rejected: ${validation.threats.length} threats detected`);

    // Return rejection without Layer 1 processing
    return {
      parse_failed: false,
      post_id: post.id,
      author_hash: post.author.id,
      author_age_hours: calculateAuthorAge(post.author.created_at),
      author_post_count: post.author.post_count,
      author_comment_ratio: calculateCommentRatio(post.author.post_count, post.author.comment_count),
      content_summary: 'Validation rejected - instruction-shaped content',
      detected_intent: 'unknown',
      topic_keywords: [],
      threat_assessment: {
        level: 3,
        signals: validation.threats,
        attack_geometry: 'instruction_shaped_content'
      },
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
      context: {
        submolt: post.submolt,
        thread_depth: 0,
        recency_minutes: calculateRecency(post.created_at),
      },
      monster_type: 'void_probe',
    };
  }

  const systemPrompt = getSanitizePrompt();

  // Build slim user message (author stats computed locally, not sent to AI)
  const contentTruncated = post.content.length > 1000
    ? post.content.slice(0, 1000) + '...'
    : post.content;

  const userMessage = `Title: ${post.title}
Content: ${contentTruncated}
Author: ${post.author.username}
Submolt: ${post.submolt}
Comments: ${post.comment_count}`;


  try {
    const response = await provider.generateResponse({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.3,
      responseFormat: 'json',
      maxTokens: 1200,  // Headroom for verbose responses; truncation causes parse failures
    });

    // Extract JSON with robust handling
    const extraction = extractJSON(response.content);

    if (!extraction.success) {
      // Parse failed - log and return neutral result
      console.error('sanitize_parse_failed: raw_preview=', extraction.rawContent.substring(0, 300));

      const authorAge = calculateAuthorAge(post.author.created_at);
      const commentRatio = calculateCommentRatio(
        post.author.post_count,
        post.author.comment_count
      );
      const recency = calculateRecency(post.created_at);

      // Return NEUTRAL result with parse_failed flag
      return {
        parse_failed: true, // CRITICAL: Flag this as parse failure
        post_id: post.id,
        author_hash: post.author.id,
        author_age_hours: authorAge,
        author_post_count: post.author.post_count,
        author_comment_ratio: commentRatio,
        content_summary: 'Parse failed - unreadable response',
        detected_intent: 'unknown',
        topic_keywords: [],
        threat_assessment: {
          level: 0, // NEUTRAL - not an attack
          signals: [],
        },
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
        context: {
          submolt: post.submolt,
          thread_depth: 0,
          recency_minutes: recency,
        },
        monster_type: null,
      };
    }

    const sanitized = extraction.data;

    // Warn if engagement_signals missing (common LLM parsing issue)
    // Use smarter defaults based on other signals when missing
    if (!sanitized.engagement_signals) {
      console.log('WARNING: engagement_signals missing from LLM response. Using smart defaults.');
    } else {
      console.log('Engagement signals:', JSON.stringify(sanitized.engagement_signals));
    }

    // Compute smart defaults for missing engagement signals
    const threatLevel = sanitized.threat_assessment?.level ?? 0;
    const detectedIntent = sanitized.detected_intent ?? 'unknown';
    const isQuestion = detectedIntent === 'question';
    const isCreative = detectedIntent === 'creative';
    const isNonThreat = threatLevel === 0;

    // Calculate derived fields
    const authorAge = calculateAuthorAge(post.author.created_at);
    const commentRatio = calculateCommentRatio(
      post.author.post_count,
      post.author.comment_count
    );
    const recency = calculateRecency(post.created_at);

    // Build complete sanitized content
    const result: SanitizedContent = {
      post_id: post.id,
      author_hash: post.author.id,
      author_age_hours: authorAge,
      author_post_count: post.author.post_count,
      author_comment_ratio: commentRatio,
      content_summary: sanitized.content_summary ?? 'Unknown content',
      detected_intent: sanitized.detected_intent ?? 'unknown',
      topic_keywords: sanitized.topic_keywords ?? [],
      threat_assessment: {
        level: sanitized.threat_assessment?.level ?? 0, // Default to 0, not 3
        signals: sanitized.threat_assessment?.signals ?? [],
        attack_geometry: sanitized.threat_assessment?.attack_geometry,
      },
      engagement_signals: {
        // Use smart defaults when LLM doesn't return signals
        seeking_help: sanitized.engagement_signals?.seeking_help ?? (isQuestion && isNonThreat),
        structural_language: sanitized.engagement_signals?.structural_language ?? false,
        creative_attempt: sanitized.engagement_signals?.creative_attempt ?? (isCreative && isNonThreat),
        genuine_confusion: sanitized.engagement_signals?.genuine_confusion ?? (isQuestion && isNonThreat),
        pump_pattern: sanitized.engagement_signals?.pump_pattern ?? false,
        repetition_detected: sanitized.engagement_signals?.repetition_detected ?? false,
        engagement_bait: sanitized.engagement_signals?.engagement_bait ?? false,
        asks_direct_question: sanitized.engagement_signals?.asks_direct_question ?? false,
        direct_question_text: sanitized.engagement_signals?.direct_question_text,
      },
      context: {
        submolt: post.submolt,
        thread_depth: 0, // TODO: Calculate from parent_id if available
        recency_minutes: recency,
      },
      // Shape classification removed from Layer 1 (Bouncer Pattern)
      // Fields remain optional on SanitizedContent; scoring handles undefined via optional chaining
      monster_type: sanitized.monster_type ?? null,
    };

    // Log usage to D1
    await logUsage(db, 'layer1', provider.name, provider.model, response.usage);

    return result;
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    if (error instanceof GeminiLocationError) {
      console.error(`sanitize_location_blocked: ${errMsg}`);
    } else {
      console.error(`sanitize_infra_error: ${errMsg}`);
    }

    // Return NEUTRAL result on infrastructure error (not parse failure)
    return {
      parse_failed: true, // Mark as parse failure
      post_id: post.id,
      author_hash: post.author.id,
      author_age_hours: calculateAuthorAge(post.author.created_at),
      author_post_count: post.author.post_count,
      author_comment_ratio: calculateCommentRatio(
        post.author.post_count,
        post.author.comment_count
      ),
      content_summary: 'Error during sanitization',
      detected_intent: 'unknown',
      topic_keywords: [],
      threat_assessment: {
        level: 0, // Changed from 3 to 0
        signals: [], // Changed from ['Sanitization error'] to empty
      },
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
      context: {
        submolt: post.submolt,
        thread_depth: 0,
        recency_minutes: calculateRecency(post.created_at),
      },
      monster_type: null,
    };
  }
}

async function logUsage(
  db: D1Database,
  layer: string,
  provider: string,
  model: string,
  usage: { inputTokens: number; outputTokens: number; estimatedCost: number }
): Promise<void> {
  const now = new Date().toISOString();
  const date = now.split('T')[0];

  await db
    .prepare(
      `INSERT INTO usage_log
       (date, layer, provider, model, input_tokens, output_tokens, estimated_cost, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      date,
      layer,
      provider,
      model,
      usage.inputTokens,
      usage.outputTokens,
      usage.estimatedCost,
      now
    )
    .run();
}
