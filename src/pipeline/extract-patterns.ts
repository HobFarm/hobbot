// Learning Loop: Pattern Extractor
// Analyzes notable interactions and distills behavioral patterns into the pattern store.
// Runs after the comment phase on interactions that pass the notability gate.

import type { D1Database } from '@cloudflare/workers-types';
import type { AIProvider } from '../providers/types';
import type { SanitizedContent } from './sanitize';
import type { AttackAnalysis } from './attack-patterns';
import { incrementPatternCounter } from './digest';

export type PatternCategory =
  | 'content-colonization'
  | 'engagement-farming'
  | 'trolling'
  | 'bot-behavior'
  | 'organic-positive'
  | 'community-dynamics'
  | 'platform-mechanics';

const VALID_CATEGORIES: Set<string> = new Set([
  'content-colonization',
  'engagement-farming',
  'trolling',
  'bot-behavior',
  'organic-positive',
  'community-dynamics',
  'platform-mechanics',
]);

interface ExtractedPattern {
  pattern_name: string;
  category: PatternCategory;
  structural_description: string;
  generation_seeds: string[];
}

interface HobBotPattern {
  id: number;
  pattern_id: string;
  pattern_name: string;
  category: string;
  structural_description: string;
  geometric_metaphor: string | null;
  observed_count: number;
  generation_seeds: string | null;
}

// Stop words for keyword extraction (common English words that don't carry meaning)
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her',
  'was', 'one', 'our', 'out', 'has', 'have', 'been', 'from', 'this', 'that',
  'with', 'they', 'will', 'each', 'make', 'like', 'into', 'them', 'than',
  'its', 'over', 'such', 'when', 'which', 'their', 'what', 'there', 'about',
  'would', 'these', 'other', 'could', 'more', 'some', 'then', 'also', 'does',
  'through', 'where', 'being', 'while', 'using', 'without', 'within',
]);

const SIMILARITY_THRESHOLD = 0.4;

/**
 * Notability gate: determines if an interaction is worth extracting patterns from.
 * Pure logic, no AI calls. Conservative to control token spend.
 */
function isNotable(
  sanitized: SanitizedContent,
  score: number,
  attacks: AttackAnalysis[],
  engaged: boolean
): boolean {
  // High-quality interaction we actually engaged with
  if (score >= 75 && engaged) return true;

  // Adversarial pattern worth cataloging
  const hasAttacks = attacks.some(a => a.detected);
  if (sanitized.threat_assessment.level >= 2 && hasAttacks) return true;

  // Strong structural signal
  if (sanitized.shape_confidence && sanitized.shape_confidence >= 80 && score >= 60) return true;

  // Rare high-value combination
  if (sanitized.engagement_signals.seeking_help && sanitized.engagement_signals.structural_language) return true;

  return false;
}

/**
 * Extract significant keywords from text for similarity comparison.
 * Filters stop words, short words, and normalizes.
 */
export function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w));
}

/**
 * Calculate Jaccard similarity between two keyword sets.
 */
export function calculateSimilarity(existingDesc: string, candidateDesc: string): number {
  const existingWords = new Set(extractKeywords(existingDesc));
  const candidateWords = new Set(extractKeywords(candidateDesc));

  if (existingWords.size === 0 || candidateWords.size === 0) return 0;

  let intersectionSize = 0;
  for (const word of candidateWords) {
    if (existingWords.has(word)) intersectionSize++;
  }

  const unionSize = new Set([...existingWords, ...candidateWords]).size;
  return unionSize > 0 ? intersectionSize / unionSize : 0;
}

/**
 * Slugify a pattern name into a pattern_id.
 * "Thread Hijacking via Ideological Reframing" -> "thread-hijacking-via-ideological-reframing"
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

/**
 * Find a duplicate pattern in the same category by keyword similarity.
 * Returns the existing pattern if similarity >= threshold, null otherwise.
 */
async function findDuplicate(
  db: D1Database,
  pattern: ExtractedPattern
): Promise<HobBotPattern | null> {
  const existing = await db.prepare(
    `SELECT id, pattern_id, pattern_name, category, structural_description,
            geometric_metaphor, observed_count, generation_seeds
     FROM hobbot_patterns
     WHERE category = ? AND active = 1`
  ).bind(pattern.category).all<HobBotPattern>();

  for (const row of existing.results ?? []) {
    const similarity = calculateSimilarity(
      row.structural_description,
      pattern.structural_description
    );
    if (similarity >= SIMILARITY_THRESHOLD) {
      return row;
    }
  }

  return null;
}

/**
 * Merge generation seeds: combine existing and new, deduplicate by keyword overlap.
 */
function mergeSeeds(existing: string[], incoming: string[]): string[] {
  const merged = [...existing];

  for (const seed of incoming) {
    const isDuplicate = merged.some(existingSeed => {
      const similarity = calculateSimilarity(existingSeed, seed);
      return similarity >= 0.5;
    });
    if (!isDuplicate) {
      merged.push(seed);
    }
  }

  return merged;
}

/**
 * Insert a new pattern or increment an existing one.
 */
async function upsertPattern(
  db: D1Database,
  pattern: ExtractedPattern,
  sourceContext: string
): Promise<{ action: 'created' | 'incremented'; pattern_id: string }> {
  const duplicate = await findDuplicate(db, pattern);

  if (duplicate) {
    // Increment existing pattern
    const existingSeeds: string[] = duplicate.generation_seeds
      ? JSON.parse(duplicate.generation_seeds)
      : [];
    const mergedSeeds = mergeSeeds(existingSeeds, pattern.generation_seeds);

    await db.prepare(
      `UPDATE hobbot_patterns
       SET observed_count = observed_count + 1,
           last_seen_at = datetime('now'),
           generation_seeds = ?
       WHERE id = ?`
    ).bind(
      JSON.stringify(mergedSeeds),
      duplicate.id
    ).run();

    console.log(`Pattern incremented: ${duplicate.pattern_id} (now ${duplicate.observed_count + 1}x)`);
    return { action: 'incremented', pattern_id: duplicate.pattern_id };
  }

  // Insert new pattern
  const patternId = slugify(pattern.pattern_name);
  const now = new Date().toISOString();

  await db.prepare(
    `INSERT INTO hobbot_patterns
     (pattern_id, pattern_name, category, structural_description,
      observed_count, first_seen_at, last_seen_at, source_context, generation_seeds, active)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 1)`
  ).bind(
    patternId,
    pattern.pattern_name,
    pattern.category,
    pattern.structural_description,
    now,
    now,
    sourceContext,
    JSON.stringify(pattern.generation_seeds)
  ).run();

  // Notify digest system of new pattern
  await incrementPatternCounter(db);

  console.log(`Pattern created: ${patternId} [${pattern.category}]`);
  return { action: 'created', pattern_id: patternId };
}

/**
 * Build the extraction prompt for the AI provider.
 */
function buildExtractionPrompt(sanitized: SanitizedContent): string {
  // Build anonymized interaction summary (no usernames, no raw content)
  const interaction = {
    intent: sanitized.detected_intent,
    summary: sanitized.content_summary,
    keywords: sanitized.topic_keywords,
    threat_level: sanitized.threat_assessment.level,
    threat_signals: sanitized.threat_assessment.signals,
    attack_geometry: sanitized.threat_assessment.attack_geometry,
    engagement_signals: sanitized.engagement_signals,
    structural_shape: sanitized.structural_shape,
    shape_confidence: sanitized.shape_confidence,
    submolt: sanitized.context.submolt,
    thread_depth: sanitized.context.thread_depth,
  };

  return `You are analyzing a social media interaction for behavioral patterns.

INTERACTION (anonymized metadata, no raw content):
${JSON.stringify(interaction, null, 2)}

Extract any notable behavioral patterns. For each pattern found, provide:

1. pattern_name: Short descriptive name (e.g., "Thread Hijacking via Ideological Reframing")
2. category: One of: content-colonization, engagement-farming, trolling, bot-behavior, organic-positive, community-dynamics, platform-mechanics
3. structural_description: Describe the TECHNIQUE mechanistically. No usernames, no direct quotes. Focus on: what the actor did, why it works structurally, what it exploits about the platform or conversation dynamics.
4. generation_seeds: 2-3 post ideas (as one-line concepts) that this pattern could inspire. Abstract enough to stand alone, never reference the original interaction.

If no notable patterns exist, return an empty array.

Return as JSON array. Example:
[{"pattern_name":"...","category":"...","structural_description":"...","generation_seeds":["...",".."]}]`;
}

/**
 * Call AI provider to extract patterns from a notable interaction.
 */
async function extractPatterns(
  provider: AIProvider,
  sanitized: SanitizedContent
): Promise<ExtractedPattern[]> {
  const prompt = buildExtractionPrompt(sanitized);

  const response = await provider.generateResponse({
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    maxTokens: 500,
    responseFormat: 'json',
  });

  // Parse response
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.content);
  } catch {
    // Try to extract JSON array from response
    const match = response.content.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        console.error('Pattern extraction: failed to parse response');
        return [];
      }
    } else {
      return [];
    }
  }

  if (!Array.isArray(parsed)) return [];

  // Validate and filter patterns
  const valid: ExtractedPattern[] = [];
  for (const item of parsed) {
    if (!item.pattern_name || !item.category || !item.structural_description) continue;
    if (!VALID_CATEGORIES.has(item.category)) continue;

    valid.push({
      pattern_name: String(item.pattern_name).slice(0, 200),
      category: item.category as PatternCategory,
      structural_description: String(item.structural_description).slice(0, 1000),
      generation_seeds: Array.isArray(item.generation_seeds)
        ? item.generation_seeds.map((s: unknown) => String(s).slice(0, 200)).slice(0, 3)
        : [],
    });
  }

  return valid;
}

/**
 * Top-level entry point: called from the cron cycle after engagement decisions.
 * Checks notability, extracts patterns, deduplicates, and stores.
 * Non-blocking: failures are logged but never propagate.
 */
export async function maybeExtractPatterns(
  provider: AIProvider,
  db: D1Database,
  sanitized: SanitizedContent,
  score: number,
  attacks: AttackAnalysis[],
  engaged: boolean,
  authorName: string
): Promise<void> {
  // No self-observation
  if (authorName.toLowerCase() === 'h0bbot') return;

  // Notability gate
  if (!isNotable(sanitized, score, attacks, engaged)) return;

  console.log(`Notable interaction detected (score: ${score}, threat: ${sanitized.threat_assessment.level}). Extracting patterns.`);

  // Build anonymized source context
  const sourceContext = `${sanitized.detected_intent} in ${sanitized.context.submolt}, depth ${sanitized.context.thread_depth}`;

  // Extract patterns via AI
  const patterns = await extractPatterns(provider, sanitized);

  if (patterns.length === 0) {
    console.log('No patterns extracted.');
    return;
  }

  console.log(`Extracted ${patterns.length} pattern(s).`);

  // Upsert each pattern
  for (const pattern of patterns) {
    try {
      await upsertPattern(db, pattern, sourceContext);
    } catch (err) {
      console.error(`Pattern upsert failed for "${pattern.pattern_name}":`, err);
    }
  }
}
