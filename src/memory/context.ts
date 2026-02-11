// Unified memory context builder
// Combines existing knowledge digest with memory knowledge entries and recent learnings
// into a single prompt block for response generation.

import type { D1Database } from '@cloudflare/workers-types';
import type { MemoryKnowledge, MemoryContext } from './types';
import { getRelevantKnowledge, formatKnowledgeEntry } from './knowledge';

const MAX_CONTEXT_CHARS = 4000;
const MAX_DIGEST_CHARS = 2500;
const MAX_KNOWLEDGE_CHARS = 800;
const MAX_LEARNINGS_CHARS = 700;

/**
 * Build a unified memory context block for injection into AI prompts.
 * Replaces raw digest injection with digest + knowledge + recent learnings.
 *
 * Priority order on truncation: digest always included, knowledge next, learnings last.
 */
export async function buildMemoryContext(
  db: D1Database,
  digest: string | null,
  authorHash?: string,
  submolt?: string,
  topics?: string[]
): Promise<MemoryContext> {
  const parts: string[] = [];

  // 1. Existing digest (structured JSON from hobbot_digest)
  const formattedDigest = digest ? formatDigestForPrompt(digest, MAX_DIGEST_CHARS) : null;

  if (formattedDigest) {
    parts.push(formattedDigest);
  }

  // 2. Relevant knowledge entries (sorted by priority + confidence)
  let relevantKnowledge: MemoryKnowledge[] = [];
  try {
    relevantKnowledge = await getRelevantKnowledge(
      db, authorHash, submolt, topics, MAX_KNOWLEDGE_CHARS
    );
  } catch (err) {
    console.error('Memory knowledge query failed:', err);
  }

  if (relevantKnowledge.length > 0) {
    const knowledgeLines = relevantKnowledge.map(formatKnowledgeEntry);
    const knowledgeBlock = knowledgeLines.join('\n');
    parts.push(`RELEVANT KNOWLEDGE:\n${truncateAtSentence(knowledgeBlock, MAX_KNOWLEDGE_CHARS)}`);
  }

  // 3. Recent cycle learnings (last 3 reflections)
  let recentLearnings: string[] = [];
  try {
    const reflections = await db.prepare(`
      SELECT learning_summary FROM memory_reflections
      WHERE learning_summary IS NOT NULL
      ORDER BY cycle_timestamp DESC
      LIMIT 3
    `).all<{ learning_summary: string }>();

    recentLearnings = (reflections.results ?? [])
      .map(r => r.learning_summary)
      .filter(Boolean);
  } catch (err) {
    console.error('Memory reflections query failed:', err);
  }

  if (recentLearnings.length > 0) {
    const learningsBlock = recentLearnings.map(l => `- ${l}`).join('\n');
    parts.push(`RECENT LEARNINGS:\n${truncateAtSentence(learningsBlock, MAX_LEARNINGS_CHARS)}`);
  }

  // Combine into single block
  const combinedPromptBlock = parts.length > 0
    ? truncateAtSentence(parts.join('\n\n'), MAX_CONTEXT_CHARS)
    : '';

  return {
    digest: formattedDigest,
    relevantKnowledge,
    recentLearnings,
    combinedPromptBlock,
  };
}

/**
 * Format the memory context for injection into a system prompt.
 * Returns the formatted string or null if empty.
 */
export function formatMemoryForPrompt(context: MemoryContext): string | null {
  if (!context.combinedPromptBlock) return null;
  return `PLATFORM INTELLIGENCE:\n${context.combinedPromptBlock}`;
}

/**
 * Format structured digest JSON into a readable prompt block.
 * Handles both new JSON format and legacy prose format.
 */
function formatDigestForPrompt(rawDigest: string, maxChars: number): string {
  try {
    const parsed = JSON.parse(rawDigest);
    const lines: string[] = [];

    if (parsed.landscape_summary) {
      lines.push(`LANDSCAPE: ${parsed.landscape_summary}`);
    }
    if (Array.isArray(parsed.dominant_patterns) && parsed.dominant_patterns.length > 0) {
      lines.push(`DOMINANT PATTERNS: ${parsed.dominant_patterns.join(', ')}`);
    }
    if (Array.isArray(parsed.emerging_trends) && parsed.emerging_trends.length > 0) {
      lines.push(`EMERGING TRENDS: ${parsed.emerging_trends.join('; ')}`);
    }
    if (Array.isArray(parsed.generation_seeds) && parsed.generation_seeds.length > 0) {
      lines.push('GENERATION SEEDS:');
      for (const seed of parsed.generation_seeds) {
        lines.push(`- ${seed}`);
      }
    }

    const result = lines.join('\n');
    return result.length <= maxChars ? result : truncateAtSentence(result, maxChars);
  } catch {
    // Legacy prose format: pass through with truncation
    return truncateAtSentence(rawDigest, maxChars);
  }
}

/**
 * Truncate text at the last sentence boundary within the character limit.
 * If no sentence boundary found, truncates at the limit.
 */
function truncateAtSentence(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  const truncated = text.slice(0, maxChars);
  // Find last sentence-ending punctuation
  const lastSentence = Math.max(
    truncated.lastIndexOf('. '),
    truncated.lastIndexOf('.\n'),
    truncated.lastIndexOf('! '),
    truncated.lastIndexOf('!\n'),
    truncated.lastIndexOf('? '),
    truncated.lastIndexOf('?\n')
  );

  if (lastSentence > maxChars * 0.5) {
    return truncated.slice(0, lastSentence + 1);
  }

  // Fallback: truncate at last newline
  const lastNewline = truncated.lastIndexOf('\n');
  if (lastNewline > maxChars * 0.5) {
    return truncated.slice(0, lastNewline);
  }

  return truncated;
}
