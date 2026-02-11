// Dream Researcher: validates patterns against live Moltbook search
// Zero AI calls. Pure data retrieval + heuristic analysis.

import type { D1Database } from '@cloudflare/workers-types';
import type { MoltbookClient } from '../moltbook/client';
import { RateLimitError } from '../moltbook/client';
import { extractKeywords } from '../pipeline/extract-patterns';
import type { PatternSnapshot, ResearchFinding, CommunityVibe } from './types';

/**
 * Derive a search query from a pattern's structural description.
 * Extracts the top 2-3 most significant keywords.
 */
function deriveSearchQuery(pattern: PatternSnapshot): string {
  const keywords = extractKeywords(pattern.structural_description);

  // Dedupe and take top 3 by length (longer words tend to be more specific)
  const unique = [...new Set(keywords)].sort((a, b) => b.length - a.length);
  const selected = unique.slice(0, 3);

  // Fall back to pattern name if description yields nothing
  if (selected.length === 0) {
    return pattern.pattern_name.replace(/-/g, ' ');
  }

  return selected.join(' ');
}

/**
 * Classify search results into a validation signal.
 */
function classifyResults(
  posts: Array<{ score: number; created_at: string }>,
): ResearchFinding['validation_signal'] {
  if (posts.length === 0) return 'unvalidated';

  const avgScore = posts.reduce((sum, p) => sum + (p.score ?? 0), 0) / posts.length;

  // Low engagement on found posts suggests pattern is present but unloved
  if (posts.length >= 3 && avgScore < 1) return 'contradicted';

  if (posts.length >= 5 && avgScore > 3) return 'confirmed';
  if (posts.length >= 2) return 'emerging';

  return 'unvalidated';
}

/**
 * Research patterns against live Moltbook search.
 * Selects top patterns by observation count and validates each via search.
 * Catches rate limit errors per-search and returns partial results.
 */
export async function researchPatterns(
  client: MoltbookClient,
  patterns: PatternSnapshot[],
  maxSearches: number = 5,
): Promise<ResearchFinding[]> {
  // Select top patterns by observation count
  const candidates = [...patterns]
    .sort((a, b) => b.observed_count - a.observed_count)
    .slice(0, maxSearches);

  const findings: ResearchFinding[] = [];

  for (const pattern of candidates) {
    const query = deriveSearchQuery(pattern);

    try {
      const posts = await client.searchPosts(query, 10);

      // Extract unique submolts from results
      const submolts = [...new Set(posts.map(p => p.submolt).filter(Boolean))];
      const avgScore = posts.length > 0
        ? posts.reduce((sum, p) => sum + (p.score ?? 0), 0) / posts.length
        : 0;

      const signal = classifyResults(
        posts.map(p => ({ score: p.score ?? 0, created_at: p.created_at })),
      );

      // Build evidence summary
      const summaryParts: string[] = [];
      summaryParts.push(`${posts.length} posts found`);
      if (avgScore > 0) summaryParts.push(`avg score ${avgScore.toFixed(1)}`);
      if (submolts.length > 0) summaryParts.push(`in ${submolts.slice(0, 3).join(', ')}`);

      findings.push({
        pattern_id: pattern.pattern_id,
        pattern_name: pattern.pattern_name,
        query,
        post_count: posts.length,
        avg_score: Math.round(avgScore * 10) / 10,
        top_submolts: submolts.slice(0, 5),
        validation_signal: signal,
        evidence_summary: summaryParts.join('; ').slice(0, 200),
      });

      console.log(`dream_research: pattern=${pattern.pattern_name}, signal=${signal}, posts=${posts.length}`);
    } catch (error) {
      if (error instanceof RateLimitError) {
        console.log(`dream_research: rate_limited, returning ${findings.length} partial findings`);
        break;
      }
      // Skip this pattern on other errors, continue with rest
      console.error(`dream_research: failed for ${pattern.pattern_name}`, error);
    }
  }

  return findings;
}

// ============================================
// Research Finding Persistence
// ============================================

/**
 * Persist research findings to the research_findings table for trend analysis.
 */
export async function persistResearchFindings(
  db: D1Database,
  dreamRunId: number,
  findings: ResearchFinding[],
): Promise<void> {
  for (const f of findings) {
    await db.prepare(`
      INSERT INTO research_findings
        (dream_run_id, pattern_id, pattern_name, query, post_count,
         avg_score, top_submolts, validation_signal, evidence_summary)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      dreamRunId,
      f.pattern_id,
      f.pattern_name,
      f.query,
      f.post_count,
      f.avg_score,
      JSON.stringify(f.top_submolts),
      f.validation_signal,
      f.evidence_summary,
    ).run();
  }
}

/**
 * Get research trend history for a specific pattern.
 * Returns the last N validation signals in chronological order (most recent first).
 */
export async function getResearchTrends(
  db: D1Database,
  patternId: string,
  limit: number = 5,
): Promise<Array<{ validation_signal: string; post_count: number; avg_score: number; created_at: string }>> {
  const result = await db.prepare(`
    SELECT validation_signal, post_count, avg_score, created_at
    FROM research_findings
    WHERE pattern_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).bind(patternId, limit).all<{
    validation_signal: string;
    post_count: number;
    avg_score: number;
    created_at: string;
  }>();
  return result.results ?? [];
}

// ============================================
// Community Vibe Check
// ============================================

// Stop words to filter from topic extraction
const STOP_WORDS = new Set([
  'this', 'that', 'with', 'from', 'have', 'been', 'were', 'they', 'their',
  'what', 'when', 'where', 'which', 'about', 'would', 'could', 'should',
  'there', 'these', 'those', 'some', 'than', 'them', 'then', 'into',
  'just', 'your', 'will', 'more', 'other', 'very', 'also', 'like',
  'does', 'here', 'each', 'make', 'much', 'most', 'only',
]);

/**
 * Get a snapshot of what the platform is currently talking about.
 * Calls getFeed('hot', 5) and extracts top topics.
 * Zero AI calls; pure keyword extraction.
 */
export async function getCommunityVibe(
  client: MoltbookClient,
): Promise<CommunityVibe | null> {
  try {
    const hotPosts = await client.getFeed('hot', 5);

    if (hotPosts.length === 0) return null;

    const submolts = [...new Set(hotPosts.map(p => p.submolt).filter(Boolean))];

    // Extract top topics from titles + content snippets
    const allWords = hotPosts
      .flatMap(p => ((p.title || '') + ' ' + (p.content || '').slice(0, 200)).toLowerCase().split(/\W+/))
      .filter(w => w.length > 3 && !STOP_WORDS.has(w));

    // Count word frequency
    const freq = new Map<string, number>();
    for (const w of allWords) {
      freq.set(w, (freq.get(w) ?? 0) + 1);
    }

    const topTopics = [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word]) => word);

    // Build description from hot post titles
    const vibeDescription = hotPosts
      .map(p => `"${p.title}" (${p.submolt}, score:${p.score ?? 0})`)
      .join('; ');

    return {
      topTopics,
      vibeDescription: vibeDescription.slice(0, 500),
      hotSubmolts: submolts.slice(0, 5),
    };
  } catch (error) {
    if (error instanceof RateLimitError) {
      console.log('dream_vibe: rate_limited');
      return null;
    }
    console.error('dream_vibe: failed', error);
    return null;
  }
}
