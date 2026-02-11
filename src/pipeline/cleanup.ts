// Duplicate post cleanup: detect and delete duplicate posts from Moltbook

import { MoltbookClient } from '../moltbook/client';

interface CleanupResult {
  deleted: number;
  errors: string[];
}

/**
 * Scan submolts for duplicate posts by H0BBOT and delete extras.
 * Keeps the post with the highest score (tiebreak: most comments, then oldest).
 * Caps at 5 submolts per cycle to limit subrequest usage.
 */
export async function cleanupDuplicatePosts(
  client: MoltbookClient,
  db: D1Database
): Promise<CleanupResult> {
  const result: CleanupResult = { deleted: 0, errors: [] };

  const submoltsResult = await db.prepare(
    `SELECT DISTINCT submolt FROM own_posts`
  ).all<{ submolt: string }>();

  const submolts = (submoltsResult.results ?? []).slice(0, 5);

  for (const { submolt } of submolts) {
    try {
      const feed = await client.getSubmoltFeed(submolt, 'new', 50);

      // Filter to H0BBOT's posts
      const myPosts = feed.filter(p =>
        p.author?.name?.toLowerCase() === 'h0bbot' ||
        p.author?.username?.toLowerCase() === 'h0bbot'
      );

      // Group by title
      const byTitle = new Map<string, typeof myPosts>();
      for (const post of myPosts) {
        const existing = byTitle.get(post.title) ?? [];
        existing.push(post);
        byTitle.set(post.title, existing);
      }

      // Delete duplicates (keep best: highest score, then most comments, then oldest)
      for (const [title, posts] of byTitle) {
        if (posts.length <= 1) continue;

        posts.sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          if (b.comment_count !== a.comment_count) return b.comment_count - a.comment_count;
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        });

        // Keep first (best), delete rest
        for (let i = 1; i < posts.length; i++) {
          try {
            await client.deletePost(posts[i].id);
            await db.prepare('DELETE FROM own_posts WHERE post_id = ?')
              .bind(posts[i].id).run();
            result.deleted++;
            console.log(`cleanup: deleted duplicate "${title}" (${posts[i].id}) from m/${submolt}`);
          } catch (err) {
            const msg = `${posts[i].id}: ${err instanceof Error ? err.message : String(err)}`;
            result.errors.push(msg);
          }
        }
      }
    } catch (err) {
      result.errors.push(`${submolt}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}
