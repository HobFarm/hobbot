// Learning Loop: Knowledge Digest
// Maintains a rolling "working memory" document synthesizing observed behavioral patterns.
// Rebuilt after every 3 new pattern insertions or daily, whichever comes first.

import type { D1Database } from '@cloudflare/workers-types';
import type { AIProvider } from '../providers/types';

interface StoredPattern {
  id: number;
  pattern_id: string;
  pattern_name: string;
  category: string;
  structural_description: string;
  geometric_metaphor: string | null;
  observed_count: number;
  first_seen_at: string;
  last_seen_at: string;
  generation_seeds: string | null;
  active: number;
}

interface DigestRow {
  content: string;
  pattern_count: number;
  active_pattern_count: number;
  patterns_since_rebuild: number;
  built_at: string;
  digest_version: number;
}

const REBUILD_THRESHOLD = 3;
const RETIRE_DAYS = 30;
const ARCHIVE_DAYS = 60;
const MAX_DIGEST_CHARS = 3000;

/**
 * Check if the digest needs to be rebuilt.
 * Triggers: 3+ new patterns since last build, OR 24+ hours since last build.
 */
export async function shouldRebuildDigest(db: D1Database): Promise<boolean> {
  const digest = await db.prepare(
    `SELECT patterns_since_rebuild, built_at FROM hobbot_digest WHERE id = 1`
  ).first<{ patterns_since_rebuild: number; built_at: string }>();

  // No digest exists yet: rebuild if any patterns exist
  if (!digest) {
    const count = await db.prepare(
      `SELECT COUNT(*) as cnt FROM hobbot_patterns WHERE active = 1`
    ).first<{ cnt: number }>();
    return (count?.cnt ?? 0) > 0;
  }

  // Check pattern count threshold
  if (digest.patterns_since_rebuild >= REBUILD_THRESHOLD) return true;

  // Check time threshold (24 hours)
  const builtAt = new Date(digest.built_at).getTime();
  const hoursSince = (Date.now() - builtAt) / (1000 * 60 * 60);
  return hoursSince >= 24;
}

/**
 * Load all active patterns for digest generation.
 */
async function loadActivePatterns(db: D1Database): Promise<StoredPattern[]> {
  const rows = await db.prepare(
    `SELECT * FROM hobbot_patterns WHERE active = 1 ORDER BY last_seen_at DESC`
  ).all<StoredPattern>();
  return rows.results ?? [];
}

/**
 * Load recently retired patterns (inactive, last seen within 60 days).
 */
async function loadRetiredPatterns(db: D1Database): Promise<StoredPattern[]> {
  const rows = await db.prepare(
    `SELECT * FROM hobbot_patterns
     WHERE active = 0 AND last_seen_at > datetime('now', '-60 days')
     ORDER BY last_seen_at DESC`
  ).all<StoredPattern>();
  return rows.results ?? [];
}

/**
 * Format relative time for display.
 */
function relativeTime(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  const hours = Math.floor(ms / (1000 * 60 * 60));
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

/**
 * Build the digest generation prompt.
 * Requests structured JSON output for storage (no persona voice).
 */
function buildDigestPrompt(patterns: StoredPattern[], retired: StoredPattern[]): string {
  const patternsForPrompt = patterns.map(p => ({
    id: p.pattern_id,
    name: p.pattern_name,
    category: p.category,
    description: p.structural_description,
    seen: p.observed_count,
    last_seen: relativeTime(p.last_seen_at),
    seeds: p.generation_seeds ? JSON.parse(p.generation_seeds) : [],
  }));

  const retiredForPrompt = retired.map(p => ({
    id: p.pattern_id,
    name: p.pattern_name,
    category: p.category,
    last_seen: relativeTime(p.last_seen_at),
  }));

  return `Analyze these behavioral patterns observed on a social platform.

ACTIVE PATTERNS:
${JSON.stringify(patternsForPrompt, null, 2)}

RECENTLY RETIRED:
${JSON.stringify(retiredForPrompt, null, 2)}

Produce a structured JSON digest with these fields:

{
  "landscape_summary": "2-3 factual sentences summarizing current platform dynamics, dominant patterns, emerging trends. Plain analytical language, no persona voice.",
  "dominant_patterns": ["pattern-id-1", "pattern-id-2"],
  "emerging_trends": ["brief factual description of each trend"],
  "generation_seeds": ["post concept 1", "post concept 2"],
  "category_breakdown": { "category-name": count },
  "retired_patterns": ["pattern-id-1"]
}

Rules:
- dominant_patterns: pattern IDs with highest observed_count
- emerging_trends: patterns seen recently with low count (new behaviors)
- generation_seeds: curated post concepts from all active patterns. Abstract, structural, never reference specific users. Quality over quantity.
- category_breakdown: count of active patterns per category
- retired_patterns: IDs of recently retired patterns, or empty array
- All text should be factual and analytical. No metaphors, no persona voice.

Return ONLY valid JSON.`;
}

/**
 * Trim digest JSON to stay within size limits.
 * Truncates generation_seeds array first, then emerging_trends.
 */
function trimDigest(digestJson: string): string {
  if (digestJson.length <= MAX_DIGEST_CHARS) return digestJson;

  try {
    const parsed = JSON.parse(digestJson);

    // First: truncate generation_seeds
    if (Array.isArray(parsed.generation_seeds)) {
      while (parsed.generation_seeds.length > 1) {
        parsed.generation_seeds.pop();
        const attempt = JSON.stringify(parsed);
        if (attempt.length <= MAX_DIGEST_CHARS) return attempt;
      }
    }

    // Second: truncate emerging_trends
    if (Array.isArray(parsed.emerging_trends)) {
      while (parsed.emerging_trends.length > 0) {
        parsed.emerging_trends.pop();
        const attempt = JSON.stringify(parsed);
        if (attempt.length <= MAX_DIGEST_CHARS) return attempt;
      }
    }

    // Third: truncate retired_patterns
    if (Array.isArray(parsed.retired_patterns)) {
      parsed.retired_patterns = [];
      const attempt = JSON.stringify(parsed);
      if (attempt.length <= MAX_DIGEST_CHARS) return attempt;
    }

    // Last resort: truncate landscape_summary
    if (typeof parsed.landscape_summary === 'string') {
      parsed.landscape_summary = parsed.landscape_summary.slice(0, 200);
    }

    return JSON.stringify(parsed).slice(0, MAX_DIGEST_CHARS);
  } catch {
    // Not valid JSON, truncate raw
    return digestJson.slice(0, MAX_DIGEST_CHARS);
  }
}

/**
 * Parse AI response into structured digest JSON.
 * Falls back to a minimal structure if parsing fails.
 */
function parseDigestResponse(rawContent: string, patterns: StoredPattern[]): Record<string, unknown> {
  const fallback = {
    landscape_summary: 'Digest parse failed. Patterns exist but synthesis unavailable.',
    dominant_patterns: patterns.slice(0, 3).map(p => p.pattern_id),
    emerging_trends: [],
    generation_seeds: patterns.flatMap(p => p.generation_seeds ? JSON.parse(p.generation_seeds).slice(0, 1) : []),
    category_breakdown: {},
    retired_patterns: [],
  };

  try {
    let jsonText = rawContent.trim();
    // Remove markdown code fences if present
    const codeBlockMatch = jsonText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeBlockMatch) {
      jsonText = codeBlockMatch[1].trim();
    }
    const parsed = JSON.parse(jsonText);

    return {
      landscape_summary: typeof parsed.landscape_summary === 'string'
        ? parsed.landscape_summary.slice(0, 500)
        : fallback.landscape_summary,
      dominant_patterns: Array.isArray(parsed.dominant_patterns)
        ? parsed.dominant_patterns.slice(0, 10).map(String)
        : fallback.dominant_patterns,
      emerging_trends: Array.isArray(parsed.emerging_trends)
        ? parsed.emerging_trends.slice(0, 5).map(String)
        : [],
      generation_seeds: Array.isArray(parsed.generation_seeds)
        ? parsed.generation_seeds.slice(0, 10).map(String)
        : fallback.generation_seeds,
      category_breakdown: parsed.category_breakdown && typeof parsed.category_breakdown === 'object'
        ? parsed.category_breakdown
        : {},
      retired_patterns: Array.isArray(parsed.retired_patterns)
        ? parsed.retired_patterns.slice(0, 10).map(String)
        : [],
    };
  } catch (err) {
    console.error('Digest parse failed:', err);
    console.error('Raw:', rawContent.slice(0, 200));
    return fallback;
  }
}

/**
 * Rebuild the knowledge digest from active patterns using AI.
 * Stores structured JSON in hobbot_digest.content.
 */
export async function rebuildDigest(
  provider: AIProvider,
  db: D1Database
): Promise<{ rebuilt: boolean; patternCount: number }> {
  const active = await loadActivePatterns(db);

  if (active.length === 0) {
    console.log('No active patterns. Skipping digest rebuild.');
    return { rebuilt: false, patternCount: 0 };
  }

  const retired = await loadRetiredPatterns(db);
  const totalCount = active.length + retired.length;

  const prompt = buildDigestPrompt(active, retired);

  const response = await provider.generateResponse({
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    maxTokens: 1500,
    responseFormat: 'json',
  });

  const structured = parseDigestResponse(response.content, active);
  let digestContent = JSON.stringify(structured);

  // Trim if needed
  digestContent = trimDigest(digestContent);

  // Upsert the digest (single-row table, id=1)
  await db.prepare(
    `INSERT INTO hobbot_digest (id, content, pattern_count, active_pattern_count, patterns_since_rebuild, built_at, digest_version)
     VALUES (1, ?, ?, ?, 0, datetime('now'), COALESCE((SELECT digest_version FROM hobbot_digest WHERE id = 1), 0) + 1)
     ON CONFLICT(id) DO UPDATE SET
       content = excluded.content,
       pattern_count = excluded.pattern_count,
       active_pattern_count = excluded.active_pattern_count,
       patterns_since_rebuild = 0,
       built_at = datetime('now'),
       digest_version = digest_version + 1`
  ).bind(digestContent, totalCount, active.length).run();

  console.log(`Digest rebuilt: ${active.length} active, ${retired.length} retired, ${digestContent.length} chars`);
  return { rebuilt: true, patternCount: active.length };
}

/**
 * Load the current knowledge digest. Returns null if none exists.
 */
export async function loadDigest(db: D1Database): Promise<string | null> {
  const row = await db.prepare(
    `SELECT content FROM hobbot_digest WHERE id = 1`
  ).first<{ content: string }>();
  return row?.content ?? null;
}

/**
 * Increment the patterns_since_rebuild counter.
 * Called from extract-patterns.ts when a NEW pattern is created (not on increment).
 */
export async function incrementPatternCounter(db: D1Database): Promise<number> {
  // Ensure the digest row exists before incrementing
  const existing = await db.prepare(
    `SELECT patterns_since_rebuild FROM hobbot_digest WHERE id = 1`
  ).first<{ patterns_since_rebuild: number }>();

  if (!existing) {
    // No digest yet; create a placeholder so counter works
    await db.prepare(
      `INSERT OR IGNORE INTO hobbot_digest (id, content, pattern_count, active_pattern_count, patterns_since_rebuild, built_at)
       VALUES (1, '', 0, 0, 1, datetime('now'))`
    ).run();
    return 1;
  }

  await db.prepare(
    `UPDATE hobbot_digest SET patterns_since_rebuild = patterns_since_rebuild + 1 WHERE id = 1`
  ).run();

  return existing.patterns_since_rebuild + 1;
}

/**
 * Retire stale patterns: mark inactive if not seen in 30+ days.
 */
export async function retireStalePatterns(db: D1Database): Promise<number> {
  const result = await db.prepare(
    `UPDATE hobbot_patterns
     SET active = 0
     WHERE active = 1 AND last_seen_at < datetime('now', '-${RETIRE_DAYS} days')`
  ).run();

  return result.meta?.changes ?? 0;
}

/**
 * Archive ancient patterns: delete patterns that have been retired for 60+ days.
 */
export async function archiveAncientPatterns(db: D1Database): Promise<number> {
  const result = await db.prepare(
    `DELETE FROM hobbot_patterns
     WHERE active = 0 AND last_seen_at < datetime('now', '-${ARCHIVE_DAYS} days')`
  ).run();

  return result.meta?.changes ?? 0;
}
