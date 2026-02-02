// Content discovery from Moltbook

import type { MoltbookClient } from '../moltbook/client';
import type { MoltbookPost } from '../moltbook/types';
import { DISCOVERY_LIMITS, SEARCH_QUERIES } from '../config';
import { filterUnseenPosts } from '../state/seen';

export async function discoverPosts(
  client: MoltbookClient,
  db: D1Database,
  queryIndex: number
): Promise<MoltbookPost[]> {
  const allPosts: MoltbookPost[] = [];

  try {
    // 1. Fetch new posts
    const newPosts = await client.getNewPosts(DISCOVERY_LIMITS.NEW_POSTS);
    allPosts.push(...newPosts);

    // 2. Fetch rising posts
    const risingPosts = await client.getRisingPosts(DISCOVERY_LIMITS.RISING_POSTS);
    allPosts.push(...risingPosts);

    // 3. Run semantic search (rotate through queries)
    const searchQuery = SEARCH_QUERIES[queryIndex % SEARCH_QUERIES.length];
    const searchResults = await client.searchPosts(searchQuery, DISCOVERY_LIMITS.SEARCH_RESULTS);
    allPosts.push(...searchResults);
  } catch (error) {
    console.error('Discovery error:', error);
    // Continue with whatever we managed to fetch
  }

  // Deduplicate by post ID
  const uniquePosts = deduplicateByPostId(allPosts);

  // Filter out posts we've already seen
  const unseenPosts = await filterUnseenPosts(db, uniquePosts);

  return unseenPosts;
}

function deduplicateByPostId(posts: MoltbookPost[]): MoltbookPost[] {
  const seen = new Map<string, MoltbookPost>();

  for (const post of posts) {
    if (!seen.has(post.id)) {
      seen.set(post.id, post);
    }
  }

  return Array.from(seen.values());
}
