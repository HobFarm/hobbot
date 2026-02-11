// Content discovery from Moltbook

import type { MoltbookClient } from '../moltbook/client';
import type { MoltbookPost } from '../moltbook/types';
import type { CycleContext } from '../state/cycle-context';
import { DISCOVERY_LIMITS, SEARCH_QUERIES } from '../config';
import { filterUnseenPosts } from '../state/seen';

export interface DiscoveredPost {
  post: MoltbookPost;
  source: 'feed' | 'rising' | 'search';
}

/**
 * Discover posts from Moltbook using personalized feed or global posts
 *
 * @param client - MoltbookClient instance
 * @param db - D1Database instance
 * @param queryIndex - Index for rotating search queries (typically cycleIndex)
 * @param usePersonalizedFeed - Use /feed endpoint (subscriptions + follows) instead of /posts
 * @returns Array of unseen posts with their discovery source
 */
export async function discoverPosts(
  client: MoltbookClient,
  db: D1Database,
  queryIndex: number,
  usePersonalizedFeed: boolean = true,
  context?: CycleContext
): Promise<DiscoveredPost[]> {
  // Track posts with their source — first occurrence wins during dedup
  const taggedPosts: Array<{ post: MoltbookPost; source: DiscoveredPost['source'] }> = [];
  const sources = { feed: false, rising: false, search: false };

  // 1. Fetch primary feed (personalized or global)
  if (usePersonalizedFeed) {
    try {
      const feedPosts = await client.getFeed('new', DISCOVERY_LIMITS.NEW_POSTS);
      taggedPosts.push(...feedPosts.map(post => ({ post, source: 'feed' as const })));
      sources.feed = true;
    } catch (error) {
      console.error('Personalized feed failed, falling back to /posts:', error);
      // Fallback to global posts
      try {
        const newPosts = await client.getNewPosts(DISCOVERY_LIMITS.NEW_POSTS);
        taggedPosts.push(...newPosts.map(post => ({ post, source: 'feed' as const })));
        sources.feed = true;
      } catch (e) {
        console.error('Fallback to new posts also failed:', e);
      }
    }
  } else {
    // Original behavior for backwards compatibility
    try {
      const newPosts = await client.getNewPosts(DISCOVERY_LIMITS.NEW_POSTS);
      taggedPosts.push(...newPosts.map(post => ({ post, source: 'feed' as const })));
      sources.feed = true;
    } catch (error) {
      console.error('New posts failed:', error);
    }
  }

  // 2. Fetch rising posts
  try {
    const risingPosts = await client.getRisingPosts(DISCOVERY_LIMITS.RISING_POSTS);
    taggedPosts.push(...risingPosts.map(post => ({ post, source: 'rising' as const })));
    sources.rising = true;
  } catch (error) {
    console.error('Rising posts failed:', error);
  }

  // 3. Run semantic search (only every 4th cycle to manage subrequests)
  if (queryIndex % 4 === 0) {
    try {
      // Divide queryIndex by 4 to still rotate through all queries over time
      const searchQuery = SEARCH_QUERIES[Math.floor(queryIndex / 4) % SEARCH_QUERIES.length];
      const searchResults = await client.searchPosts(searchQuery, DISCOVERY_LIMITS.SEARCH_RESULTS);
      taggedPosts.push(...searchResults.map(post => ({ post, source: 'search' as const })));
      sources.search = true;
    } catch (error) {
      console.error('Search failed:', error);
    }
  }

  // Log which sources succeeded
  const expectedSources = queryIndex % 4 === 0 ? 3 : 2;
  const successCount = Object.values(sources).filter(Boolean).length;
  if (successCount < expectedSources) {
    console.log(`Partial discovery: ${successCount}/${expectedSources} sources (feed:${sources.feed}, rising:${sources.rising}${queryIndex % 4 === 0 ? `, search:${sources.search}` : ''})`);
  }

  // Diagnostic: log first author's available fields to discover API response shape
  if (taggedPosts.length > 0 && taggedPosts[0].post.author) {
    console.log('Author fields available:', Object.keys(taggedPosts[0].post.author).join(', '));
  }

  // Normalize fields: API may return objects instead of strings
  const normalized = taggedPosts.map(({ post, source }) => ({
    post: {
      ...post,
      // Normalize submolt: API may return object {name, description, ...} instead of string
      submolt: typeof post.submolt === 'object' && post.submolt !== null
        ? (post.submolt as unknown as { name: string }).name
        : post.submolt,
      author: post.author ? {
        ...post.author,
        username: post.author.username ||
                  (post.author as unknown as Record<string, unknown>).name as string ||
                  (post.author as unknown as Record<string, unknown>).display_name as string ||
                  post.author.id ||
                  'anon'
      } : null
    },
    source,
  }));

  // Debug: log sample post to verify normalization
  if (normalized.length > 0) {
    const sample = normalized[0];
    console.log(`Sample post author: ${sample.post.author ? sample.post.author.username : 'NULL'}`);
  }

  // Deduplicate by post ID — first occurrence wins (feed > rising > search priority)
  const sourceMap = new Map<string, DiscoveredPost['source']>();
  const deduped = deduplicateTagged(normalized, sourceMap);

  // Filter out posts we've already seen
  const unseenPosts = await filterUnseenPosts(db, deduped);

  // Context-informed sorting: process quality content first, suppressed submolts last
  if (context && context.confidence !== 'low' && context.suppressedSubmolts.size > 0) {
    unseenPosts.sort((a, b) => {
      const aSuppressed = context.suppressedSubmolts.has(a.submolt) ? -30 : 0;
      const bSuppressed = context.suppressedSubmolts.has(b.submolt) ? -30 : 0;
      return bSuppressed - aSuppressed;
    });
  }

  // Reconstruct tagged results
  return unseenPosts.map(post => ({
    post,
    source: sourceMap.get(post.id) ?? 'feed',
  }));
}

function deduplicateTagged(
  tagged: Array<{ post: MoltbookPost; source: DiscoveredPost['source'] }>,
  sourceMap: Map<string, DiscoveredPost['source']>
): MoltbookPost[] {
  const seen = new Map<string, MoltbookPost>();

  for (const { post, source } of tagged) {
    if (!seen.has(post.id)) {
      seen.set(post.id, post);
      sourceMap.set(post.id, source);
    }
  }

  return Array.from(seen.values());
}
