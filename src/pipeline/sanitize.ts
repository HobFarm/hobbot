// Layer 1: Content sanitization - converts raw content to structured JSON

import type { AIProvider } from '../providers/types';
import type { MoltbookPost } from '../moltbook/types';
import { getSanitizePrompt } from '../prompts/sanitize';

export interface SanitizedContent {
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
  };
  context: {
    submolt: string;
    thread_depth: number;
    recency_minutes: number;
  };
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

export async function sanitizePost(
  provider: AIProvider,
  post: MoltbookPost,
  db: D1Database
): Promise<SanitizedContent> {
  const systemPrompt = getSanitizePrompt();

  // Build the user message with post data
  const userMessage = `Analyze this post:

Title: ${post.title}
Content: ${post.content}
Author ID: ${post.author.id}
Author Username: ${post.author.username}
Author Created: ${post.author.created_at}
Author Post Count: ${post.author.post_count}
Author Comment Count: ${post.author.comment_count}
Submolt: ${post.submolt}
Created At: ${post.created_at}
Comment Count: ${post.comment_count}

Extract metadata and output JSON only.`;

  try {
    const response = await provider.generateResponse({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: 0,
      responseFormat: 'json',
    });

    // Parse the JSON response
    const sanitized = JSON.parse(response.content) as Partial<SanitizedContent>;

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
        level: sanitized.threat_assessment?.level ?? 3,
        signals: sanitized.threat_assessment?.signals ?? ['Parse error'],
        attack_geometry: sanitized.threat_assessment?.attack_geometry,
      },
      engagement_signals: {
        seeking_help: sanitized.engagement_signals?.seeking_help ?? false,
        structural_language: sanitized.engagement_signals?.structural_language ?? false,
        creative_attempt: sanitized.engagement_signals?.creative_attempt ?? false,
        genuine_confusion: sanitized.engagement_signals?.genuine_confusion ?? false,
        pump_pattern: sanitized.engagement_signals?.pump_pattern ?? false,
        repetition_detected: sanitized.engagement_signals?.repetition_detected ?? false,
        engagement_bait: sanitized.engagement_signals?.engagement_bait ?? false,
      },
      context: {
        submolt: post.submolt,
        thread_depth: 0, // TODO: Calculate from parent_id if available
        recency_minutes: recency,
      },
    };

    // Log usage to D1
    await logUsage(db, 'layer1', provider.name, provider.model, response.usage);

    return result;
  } catch (error) {
    console.error('Sanitization error:', error);

    // Default to highest threat level on error
    return {
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
        level: 3,
        signals: ['Sanitization error'],
      },
      engagement_signals: {
        seeking_help: false,
        structural_language: false,
        creative_attempt: false,
        genuine_confusion: false,
        pump_pattern: false,
        repetition_detected: false,
        engagement_bait: false,
      },
      context: {
        submolt: post.submolt,
        thread_depth: 0,
        recency_minutes: calculateRecency(post.created_at),
      },
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
