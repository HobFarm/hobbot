// Semantic probe: fallback discovery via stale-rotating search queries

import { MoltbookClient } from '../moltbook/client';
import type { DiscoveredPost } from './discover';
import { filterUnseenPosts } from '../state/seen';

const PROBE_SEED_QUERIES: Array<{ query: string; category: string }> = [
  // Structural analysis (broken-geometry territory)
  { query: 'why does my system break', category: 'structural' },
  { query: 'failure mode analysis', category: 'structural' },
  { query: 'architecture collapse', category: 'structural' },
  { query: 'design flaw pattern', category: 'structural' },
  // Signal analysis (echo-canyon territory)
  { query: 'signal vs noise', category: 'signal' },
  { query: 'information propagation', category: 'signal' },
  { query: 'echo chamber effect', category: 'signal' },
  { query: 'pattern recognition system', category: 'signal' },
  // Operational (high-value engagement)
  { query: 'pipeline keeps failing', category: 'operational' },
  { query: 'agent coordination problem', category: 'operational' },
  { query: 'state management issue', category: 'operational' },
  { query: 'debugging distributed system', category: 'operational' },
  // Creative (territory-adjacent)
  { query: 'narrative structure breakdown', category: 'creative' },
  { query: 'story architecture', category: 'creative' },
  { query: 'worldbuilding system', category: 'creative' },
];

async function ensureSeedQueries(db: D1Database): Promise<void> {
  const count = await db
    .prepare('SELECT COUNT(*) as c FROM semantic_probes')
    .first<{ c: number }>();

  if (count && count.c > 0) return;

  for (const seed of PROBE_SEED_QUERIES) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO semantic_probes (query_text, category) VALUES (?, ?)`
      )
      .bind(seed.query, seed.category)
      .run();
  }
}

export async function runSemanticProbe(
  client: MoltbookClient,
  db: D1Database,
  maxResults: number = 10
): Promise<DiscoveredPost[]> {
  await ensureSeedQueries(db);

  // Select stalest query (never-used first, then least-recently-used)
  const probe = await db
    .prepare(
      `SELECT id, query_text FROM semantic_probes
       ORDER BY last_used_at ASC NULLS FIRST, use_count ASC
       LIMIT 1`
    )
    .first<{ id: number; query_text: string }>();

  if (!probe) return [];

  console.log(`semantic_probe: query="${probe.query_text}"`);

  let posts;
  try {
    const searchResult = await client.searchPosts(probe.query_text, maxResults);
    posts = searchResult;
  } catch (error) {
    console.error(`semantic_probe: search failed for "${probe.query_text}"`, error);
    // Don't update last_used_at on failure so query retries next time
    return [];
  }

  if (!posts || posts.length === 0) {
    // Update stats even on zero results (rotate away from unproductive queries)
    await db
      .prepare(
        `UPDATE semantic_probes SET last_used_at = datetime('now'), use_count = use_count + 1 WHERE id = ?`
      )
      .bind(probe.id)
      .run();
    return [];
  }

  // Normalize submolt field (same as discover.ts)
  for (const post of posts) {
    if (post.submolt && typeof post.submolt === 'object') {
      post.submolt = (post.submolt as unknown as { name: string }).name;
    }
  }

  // Filter already-seen posts
  const unseen = await filterUnseenPosts(db, posts);

  // Update probe stats
  await db
    .prepare(
      `UPDATE semantic_probes
       SET last_used_at = datetime('now'), use_count = use_count + 1, yield_count = yield_count + ?
       WHERE id = ?`
    )
    .bind(unseen.length, probe.id)
    .run();

  console.log(`semantic_probe: results=${posts.length}, unseen=${unseen.length}`);

  return unseen.map((post) => ({ post, source: 'search' as const }));
}

export async function addProbeQuery(
  db: D1Database,
  query: string,
  category: string
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO semantic_probes (query_text, category) VALUES (?, ?)`
    )
    .bind(query, category)
    .run();
}
