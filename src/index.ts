// Main cron handler and orchestration

import { MoltbookClient } from './moltbook/client';
import { getProvider, GeminiLocationError } from './providers';
import type { AIProvider } from './providers/types';
import {
  getTodayBudget,
  canPost,
  recordPost,
  getTimeSinceLastPost,
  getDailyTokenSpend,
  isRateLimited,
  setRateLimitedUntil,
  calculateIterationBudget,
  getRemainingIterationBudget,
  logIterationBudget,
  getCycleTokenBreakdown,
  resetSubrequestCount,
  incrementSubrequestCount,
  isNearSubrequestLimit,
  getSubrequestCount,
} from './state/budget';
import { runMigrations } from './state/schema';
import { markAsSeen, isBlacklisted, blacklistThread, cleanExpiredBlacklist } from './state/seen';
import { hashContent } from './state/audit';
import { addToCollection, getAttackCount } from './state/collection';
import {
  recordAuthorSignal,
  getRecentSignalCount,
  recordAttackSignal,
} from './state/author-signals';
import { discoverPosts } from './pipeline/discover';
import { sanitizePost } from './pipeline/sanitize';
import { scoreTarget, isCommentWorthy } from './pipeline/score';
import {
  generateResponse,
  generateCatalogResponse,
  generateDeflectionResponse,
  getAttackResponse,
  shouldRespondToAttack,
} from './pipeline/respond';
import { postComment, createPost, trackOwnPost } from './pipeline/post';
import { cleanupDuplicatePosts } from './pipeline/cleanup';
import { generatePost, maybePostGlossaryEntry, hasConcreteAnchor } from './pipeline/generate-post';
import {
  checkOwnPosts,
  queueWorthyComments,
  processReplyQueue,
} from './pipeline/replies';
import {
  runFilterPipeline,
  logFilterStats,
} from './pipeline/reply-filters';
import { runReflectPhase } from './pipeline/reflect';
import {
  getRelevantSubmolts,
  selectSubmolt,
  recordSubmoltPost,
  getLastSubmoltRefresh,
  refreshSubmolts,
  initializeHobfarm
} from './moltbook/submolts';
import { initializeSubscriptions } from './moltbook/subscriptions';
import { upvoteAndTrackAuthor, checkForFollowOpportunity } from './pipeline/engage';
import { checkDMs, getPendingDMCount } from './pipeline/dm-check';
import { BUDGET, POST_GENERATION, TOKEN_BUDGET, PROCESSING_LIMITS, SCORING_THRESHOLDS, generateConstraintStatement, COMMENT_SPACING_MS, PROBE_FALLBACK_THRESHOLD } from './config';
import {
  analyzeComment,
  isWhitelisted,
  getPrimaryAttack,
} from './pipeline/attack-patterns';
import { detectDrift, driftToAttackAnalysis } from './pipeline/drift-detect';
import {
  recordPlatformSignal,
  recordPlatformSignalsBatch,
  recordShapeObservationsBatch,
  recordEngagementPatternsBatch,
  type PlatformSignalEntry,
  type ShapeObservationEntry,
  type EngagementPatternEntry,
} from './state/observations';
import { upsertAgentProfile, isProfileStale, MAX_PROFILE_FETCHES_PER_CYCLE } from './state/agent-profiles';
import { startTrace } from './pipeline/decision-trace';
import { loadCycleContext, recordCycleSummary, type CycleContext } from './state/cycle-context';
import { maybeExtractPatterns } from './pipeline/extract-patterns';
import { loadDigest, shouldRebuildDigest, rebuildDigest, retireStalePatterns, archiveAncientPatterns } from './pipeline/digest';
import { createCycleCollector, recordNotableInteraction, getCycleEvents } from './memory/observe';
import { buildMemoryContext, formatMemoryForPrompt } from './memory/context';
import { runMemoryReflection } from './memory/reflect';
import { decayStaleKnowledge, pruneDeadKnowledge } from './memory/knowledge';
import { runSovereignCheck } from './state/sovereign';
import { runSemanticProbe } from './pipeline/probe';
import { runLucidDream, getLastDreamRun } from './dream/synthesize';

// Helper for comment spacing delays
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export interface Env {
  DB: D1Database;
  MOLTBOOK_API_KEY: string;
  GEMINI_API_KEY: string;
  DRY_RUN: string;
  LAYER1_PROVIDER: string;
  LAYER1_MODEL: string;
  LAYER2_PROVIDER: string;
  LAYER2_MODEL: string;
  ACTIVE_HOURS_START: string;
  ACTIVE_HOURS_END: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Handle favicon to reduce noise
    if (url.pathname === '/favicon.ico') {
      return new Response(null, { status: 204 });
    }

    // Health check endpoint
    if (url.pathname === '/' && request.method === 'GET') {
      try {
        const budget = await getTodayBudget(env.DB);
        const attackCount = await getAttackCount(env.DB);
        const pendingDMs = await getPendingDMCount(env.DB);
        const currentHour = new Date().getUTCHours();
        const activeStart = parseInt(env.ACTIVE_HOURS_START || '8');
        const activeEnd = parseInt(env.ACTIVE_HOURS_END || '24');

        // Get last run timestamp from budget
        const lastRun = budget.last_comment_at || budget.last_post_at || 'never';

        let status = 'Watching.';
        if (budget.comments_used >= budget.comments_max && budget.posts_used >= budget.posts_max) {
          status = "No budget remaining.";
        } else if (currentHour < activeStart || currentHour >= activeEnd) {
          status = 'Resting.';
        }

        const health = {
          status,
          bot: 'H0BBOT',
          timestamp: new Date().toISOString(),
          attack_catalog_size: attackCount,
          dm_requests_pending: pendingDMs,
          well: {
            comments: `${budget.comments_used}/${budget.comments_max}`,
            posts: `${budget.posts_used}/${budget.posts_max}`,
            upvotes: `${budget.upvotes_used}/${budget.upvotes_max}`,
            follows: `${budget.follows_used}/${budget.follows_max}`,
          },
          last_waking: lastRun,
        };

        return new Response(JSON.stringify(health, null, 2), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (error) {
        return new Response(
          JSON.stringify({ status: 'error', message: String(error) }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    // Transparency endpoint - publicly state constraints (Phase 4)
    if (url.pathname === '/constraints' && request.method === 'GET') {
      return new Response(generateConstraintStatement(), {
        headers: { 'Content-Type': 'text/plain' }
      });
    }

    // CORS preflight for archive endpoint
    if (url.pathname === '/api/archive' && request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': 'https://hob.farm',
          'Access-Control-Allow-Methods': 'GET',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // Living Archive endpoint - serves data for hob.farm/projects/hobbot
    if (url.pathname === '/api/archive' && request.method === 'GET') {
      try {
        const archiveHeaders = {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': 'https://hob.farm',
          'Cache-Control': 'public, max-age=300',
        };

        // Run all queries in parallel
        const [
          postCount,
          commentSum,
          catalogCount,
          glossaryCount,
          processedCount,
          postDates,
          recent,
          featured,
          glossary,
        ] = await Promise.all([
          env.DB.prepare('SELECT COUNT(*) as c FROM own_posts').first<{ c: number }>(),
          env.DB.prepare('SELECT SUM(comment_count) as c FROM own_posts').first<{ c: number }>(),
          env.DB.prepare('SELECT COUNT(*) as c FROM attack_collection').first<{ c: number }>(),
          env.DB.prepare('SELECT COUNT(*) as c FROM glossary_entries').first<{ c: number }>(),
          env.DB.prepare('SELECT COUNT(*) as c FROM seen_posts').first<{ c: number }>(),
          env.DB.prepare('SELECT MIN(created_at) as first, MAX(created_at) as last FROM own_posts').first<{ first: string; last: string }>(),
          env.DB.prepare(
            'SELECT post_id, title, submolt, created_at, comment_count FROM own_posts ORDER BY created_at DESC LIMIT 10'
          ).all<{ post_id: string; title: string; submolt: string; created_at: string; comment_count: number }>(),
          env.DB.prepare(
            'SELECT post_id, title, submolt, created_at, comment_count FROM own_posts ORDER BY comment_count DESC LIMIT 4'
          ).all<{ post_id: string; title: string; submolt: string; created_at: string; comment_count: number }>(),
          env.DB.prepare(
            'SELECT term, definition, relevance, example, posted_at, entry_number FROM glossary_entries ORDER BY entry_number ASC'
          ).all<{ term: string; definition: string; relevance: string; example: string; posted_at: string; entry_number: number }>(),
        ]);

        const mapPost = (p: { post_id: string; title: string; submolt: string; created_at: string; comment_count: number }) => ({
          title: p.title,
          submolt: p.submolt,
          created_at: p.created_at,
          url: `https://moltbook.com/post/${p.post_id}`,
          comment_count: p.comment_count,
        });

        const payload = {
          stats: {
            total_posts: postCount?.c ?? 0,
            total_comments: commentSum?.c ?? 0,
            catalog_entries: catalogCount?.c ?? 0,
            glossary_terms: glossaryCount?.c ?? 0,
            posts_processed: processedCount?.c ?? 0,
            first_post: postDates?.first ?? null,
            last_active: postDates?.last ?? null,
          },
          recent: (recent.results ?? []).map(mapPost),
          featured: (featured.results ?? []).map(mapPost),
          glossary: glossary.results ?? [],
        };

        return new Response(JSON.stringify(payload), { headers: archiveHeaders });
      } catch (error) {
        return new Response(
          JSON.stringify({ status: 'error', message: String(error) }),
          {
            status: 500,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': 'https://hob.farm',
            },
          }
        );
      }
    }

    // Debug endpoint to manually trigger cron logic
    if (url.pathname === '/debug-cron') {
      try {
        // Run the same cron logic as scheduled handler
        await runCron(env);
        return new Response(JSON.stringify({ ok: true, message: 'Cron executed successfully' }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Cleanup endpoint to delete broken comments
    // Usage: Add comment IDs to the array, deploy, then call /cleanup-comments
    if (url.pathname === '/cleanup-comments') {
      const client = new MoltbookClient(env.MOLTBOOK_API_KEY, undefined, env.DB);

      // List of comment IDs to delete (populated manually from profile review)
      // Find these by visiting HobBot's Moltbook profile and finding comments with:
      // - "shape remains unformed"
      // - "no discernible geometry"
      // - "geometry remains undefined"
      // - incomplete sentences
      const brokenCommentIds: string[] = [
        // Add IDs here after reviewing HobBot's Moltbook profile
        // Example: 'abc123', 'def456'
      ];

      if (brokenCommentIds.length === 0) {
        return new Response(JSON.stringify({
          message: 'No comment IDs specified. Add IDs to brokenCommentIds array in index.ts',
          instructions: 'Visit HobBot profile on Moltbook, find broken comments, copy their IDs'
        }, null, 2), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const results = { deleted: 0, failed: 0, errors: [] as string[] };

      for (const id of brokenCommentIds) {
        try {
          await client.deleteComment(id);
          results.deleted++;
          console.log(`Deleted comment: ${id}`);
        } catch (error) {
          results.failed++;
          results.errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      return new Response(JSON.stringify(results, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Cleanup endpoint to delete duplicate posts (same title)
    // Keeps the oldest post, deletes newer duplicates
    if (url.pathname === '/debug-cleanup') {
      const client = new MoltbookClient(env.MOLTBOOK_API_KEY, undefined, env.DB);

      // Find titles with more than one post
      const dupes = await env.DB.prepare(`
        SELECT title, COUNT(*) as count
        FROM own_posts
        GROUP BY title
        HAVING count > 1
      `).all<{ title: string; count: number }>();

      const results = { cleaned: 0, failed: 0, errors: [] as string[] };

      for (const group of dupes.results ?? []) {
        // Get all posts with this title, oldest first
        const posts = await env.DB.prepare(`
          SELECT post_id, created_at FROM own_posts
          WHERE title = ?
          ORDER BY created_at ASC
        `).bind(group.title).all<{ post_id: string; created_at: string }>();

        // Skip first (oldest), delete the rest
        for (let i = 1; i < (posts.results?.length ?? 0); i++) {
          const postId = posts.results![i].post_id;
          try {
            await client.deletePost(postId);
            await env.DB.prepare('DELETE FROM own_posts WHERE post_id = ?')
              .bind(postId).run();
            results.cleaned++;
            console.log(`Cleaned duplicate: ${group.title} (post_id: ${postId})`);
          } catch (error) {
            results.failed++;
            results.errors.push(`${postId}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }

      return new Response(JSON.stringify({
        message: results.cleaned > 0 ? `Cleaned ${results.cleaned} duplicate posts` : 'No duplicates found',
        ...results
      }, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 404 for other paths
    return new Response('Not Found', { status: 404 });
  },

  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    // HobBot cron disabled - Moltbook platform retired
    console.log('cron_disabled: moltbook_retired');
    return;
    // ctx.waitUntil(runCron(env));
  },
};

async function runCron(env: Env): Promise<void> {
  console.log('cron_start');
  const startTime = Date.now();
  resetSubrequestCount();

  // Run any pending database migrations
  await runMigrations(env.DB);

  try {
    // Get current hour for various time-based checks
    const currentHour = new Date().getUTCHours();

    // 0. Daily submolt refresh (FIRST, before active hours check)
    if (currentHour === 8) {
      try {
        const lastRefresh = await getLastSubmoltRefresh(env.DB);
        const hoursSinceRefresh = lastRefresh
          ? (Date.now() - new Date(lastRefresh).getTime()) / 3600000
          : Infinity;

        // Only refresh if >20 hours since last refresh (prevents re-runs at 8:15, 8:30, etc)
        if (hoursSinceRefresh >= 20) {
          console.log('submolt_refresh: starting');
          await refreshSubmolts(env);
          console.log('submolt_refresh: complete');

          // Initialize hobfarm if not already established
          const dryRun = env.DRY_RUN === 'true';
          const tempClient = new MoltbookClient(env.MOLTBOOK_API_KEY, undefined, env.DB);
          try {
            await initializeHobfarm(tempClient, env.DB, dryRun);
          } catch (error) {
            // Use error.name check instead of instanceof (more reliable across async boundaries)
            if (error instanceof Error && error.name === 'RateLimitError') {
              console.log('submolt_refresh: hobfarm_rate_limited, retry=next_cycle');
            } else {
              throw error;
            }
          }

          // Initialize subscriptions for personalized feed (separate try-catch)
          try {
            console.log('subscriptions: checking');
            const subResult = await initializeSubscriptions(tempClient, env.DB, dryRun);
            if (subResult.subscribed.length > 0) {
              console.log(`subscriptions: added=${subResult.subscribed.length}`);
            }
            if (subResult.failed.length > 0) {
              console.log(`subscriptions: failed=${subResult.failed.join(', ')}`);
            }
          } catch (error) {
            if (error instanceof Error && error.name === 'RateLimitError') {
              console.log('subscriptions: rate_limited, retry=next_cycle');
            } else {
              console.error('subscriptions: init_failed', error);
            }
          }
        } else {
          console.log(`submolt_refresh: skip, hours_since=${Math.floor(hoursSinceRefresh)}`);
        }
      } catch (error) {
        console.error('submolt_refresh: failed', error);
        // Continue - don't block main processing
      }
    }

    // 0.5 Lucid Dream: 24h deep synthesis (2 AM UTC, before active hours check)
    if (currentHour === 2) {
      try {
        const lastDream = await getLastDreamRun(env.DB);
        const hoursSinceDream = lastDream
          ? (Date.now() - new Date(lastDream).getTime()) / 3600000
          : Infinity;

        if (hoursSinceDream >= 20) {
          console.log('dream_phase: starting');
          const dreamLayer2 = getProvider(env.LAYER2_PROVIDER, env.LAYER2_MODEL, env.GEMINI_API_KEY);
          const dreamClient = new MoltbookClient(env.MOLTBOOK_API_KEY, undefined, env.DB);
          const dreamResult = await runLucidDream(env.DB, dreamLayer2, dreamClient);
          console.log(`dream_phase: complete, evolved=${dreamResult.patternsEvolved}, research=${dreamResult.researchFindings}, drafts=${dreamResult.glossaryDraftsCreated}, promoted=${dreamResult.glossaryDraftsPromoted}, dm_signals=${dreamResult.dmSignalsFound}`);

          // Trigger digest rebuild if patterns were refined
          if (dreamResult.needsDigestRebuild) {
            const dreamLayer1 = getProvider(env.LAYER1_PROVIDER, env.LAYER1_MODEL, env.GEMINI_API_KEY);
            await rebuildDigest(dreamLayer1, env.DB);
            console.log('dream_phase: digest_rebuilt');
          }
        } else {
          console.log(`dream_phase: skip, hours_since=${Math.floor(hoursSinceDream)}`);
        }
      } catch (error) {
        console.error('dream_phase: failed', error);
        // Non-blocking: dream failure never crashes the cron
      }
    }

    // 1. Check active hours (8:00-24:00 UTC)
    const activeStart = parseInt(env.ACTIVE_HOURS_START);
    const activeEnd = parseInt(env.ACTIVE_HOURS_END);

    if (currentHour < activeStart || currentHour >= activeEnd) {
      console.log(`cycle_skip: outside_active_hours, current=${currentHour}, window=${activeStart}-${activeEnd}`);
      return;
    }

    // 2. Load daily budget
    const budget = await getTodayBudget(env.DB);
    console.log('budget:', budget);

    // 3. Check if budget exhausted
    if (budget.comments_used >= budget.comments_max && budget.posts_used >= budget.posts_max) {
      console.log(`cycle_skip: budget_exhausted, comments=${budget.comments_used}/${budget.comments_max}, posts=${budget.posts_used}/${budget.posts_max}`);
      return;
    }

    // 3.5 Token budget check (BEFORE any API calls)
    // Tiers: full (< soft) | reduced (soft-hard) | shutdown (> hard)
    const tokenSpend = await getDailyTokenSpend(env.DB);
    type TokenMode = 'full' | 'reduced' | 'shutdown';
    let tokenMode: TokenMode = 'full';

    if (tokenSpend >= TOKEN_BUDGET.daily_hard_limit) {
      console.log(`cycle_skip: token_hard_limit, spent=${tokenSpend}, limit=${TOKEN_BUDGET.daily_hard_limit}`);
      return;
    }
    if (tokenSpend >= TOKEN_BUDGET.daily_soft_limit) {
      tokenMode = 'reduced';
      console.log(`token_mode: reduced, spend=${tokenSpend}, soft_limit=${TOKEN_BUDGET.daily_soft_limit}, hard_limit=${TOKEN_BUDGET.daily_hard_limit}`);
    }

    // 4. Initialize clients
    const moltbookClient = new MoltbookClient(env.MOLTBOOK_API_KEY, undefined, env.DB);

    // Verify API key at startup
    try {
      const me = await moltbookClient.getMe();
      const agentName = me.name || me.username || me.id || 'unknown';
      console.log(`api_verified: agent=${agentName}`);
    } catch (error) {
      if (error instanceof Error) {
        // Check for account suspension
        if ((error as any).suspensionInfo) {
          console.error('cycle_abort: account_suspended', (error as any).suspensionInfo.reason);
          return;
        }
        // Check for invalid API key
        if (error.message.includes('401') || error.message.includes('Invalid API key')) {
          console.error('cycle_abort: api_key_invalid');
          return;
        }
      }
      console.warn('api_verify: skipped', error);
    }

    const layer1Provider = getProvider(
      env.LAYER1_PROVIDER,
      env.LAYER1_MODEL,
      env.GEMINI_API_KEY
    );
    const layer2Provider = getProvider(
      env.LAYER2_PROVIDER,
      env.LAYER2_MODEL,
      env.GEMINI_API_KEY
    );

    const dryRun = env.DRY_RUN === 'true';
    if (dryRun) {
      console.log('mode: dry_run=true');
    }

    // 4.5 Check DMs for activity
    try {
      const dmResult = await checkDMs(moltbookClient, env.DB);
      if (dmResult.humanNotificationNeeded) {
        console.log(`dm_check: pending_requests=${dmResult.requestsForHuman.length}`);
      }
    } catch (error) {
      console.error('dm_check: failed', error);
    }

    // 5.5. Load accumulated intelligence
    let context: CycleContext | undefined;
    let knowledgeDigest: string | null = null;
    let memoryContext: string | null = null;
    try {
      const [ctx, digest] = await Promise.all([
        loadCycleContext(env.DB),
        loadDigest(env.DB),
      ]);
      context = ctx;
      knowledgeDigest = digest;
      console.log(`context_loaded: observations=${context.totalObservations}, confidence=${context.confidence}`);
      if (knowledgeDigest) {
        console.log(`digest_loaded: chars=${knowledgeDigest.length}`);
      }
      if (context.suppressedSubmolts.size > 0) {
        console.log(`context_suppressed: submolts=${[...context.suppressedSubmolts].join(', ')}`);
      }

      // Build unified memory context (digest + knowledge + learnings)
      const memCtx = await buildMemoryContext(env.DB, knowledgeDigest);
      memoryContext = formatMemoryForPrompt(memCtx);
      if (memCtx.relevantKnowledge.length > 0 || memCtx.recentLearnings.length > 0) {
        console.log(`memory_loaded: knowledge=${memCtx.relevantKnowledge.length}, learnings=${memCtx.recentLearnings.length}`);
      }
    } catch (err) {
      console.error('context_load: failed', err);
      await recordPlatformSignal(env.DB, 'error:context_load_failure', 'system');
    }

    // 6. Check if we can comment, reply, or post
    const canComment = budget.comments_used < budget.comments_max;
    const canReply = budget.replies_used < budget.replies_max;
    const canPost = budget.posts_used < budget.posts_max;

    if (!canComment && !canPost) {
      console.log('cycle_skip: no_comment_or_post_budget');
      return;
    }

    // Calculate cycle index early (needed by multiple phases)
    const minutesInHour = new Date().getUTCMinutes();
    const cycleIndex = Math.floor(minutesInHour / 15);

    // Initialize memory cycle collector (accumulates events for reflection phase)
    const cycleCollector = createCycleCollector();

    // 7. Reply phase - RUNS FIRST to ensure budget allocation
    // Uses 20% of iteration budget (2 replies per cycle)
    // Skip in conservation mode to save CPU
    if (canReply) {
      console.log('reply_phase: starting');

      // Calculate iteration budget (40/40/20 split: replies get 20%)
      const iterationBudget = calculateIterationBudget();
      const remainingBudget = await getRemainingIterationBudget(env.DB, iterationBudget);
      logIterationBudget(remainingBudget);

      // Check own posts from last 72 hours (capped to limit subrequest usage)
      const ownPosts = await checkOwnPosts(moltbookClient, env.DB, 72, PROCESSING_LIMITS.MAX_OWN_POSTS_CHECKED);
      console.log(`reply_phase: own_posts=${ownPosts.length}`);

      // Apply 5-layer spam filters BEFORE scoring API calls
      const filteredPosts: Array<{ post: typeof ownPosts[0]['post']; comments: typeof ownPosts[0]['comments']; effectiveThreshold: number }> = [];

      for (const { post, comments } of ownPosts) {
        // Thread blacklist check (sticky skip across cycles)
        if (await isBlacklisted(env.DB, post.post_id)) {
          console.log(`reply_skip: post=${post.post_id.slice(0, 8)}, reason=blacklisted`);
          continue;
        }

        // Swarmed-post detection handled by noise ratio filter below (line ~598)
        // which blacklists threads where >50% of comments are filtered out.

        // Run the 5-layer filter pipeline
        const filterResult = await runFilterPipeline(env.DB, post, comments, 'H0BBOT');
        logFilterStats(post.post_id, filterResult.stats, filterResult.effectiveThreshold);

        // Noise ratio detection: blacklist threads dominated by garbage
        const totalComments = comments.length;
        const filteredOut = totalComments - filterResult.filteredComments.length;
        const noiseRatio = totalComments > 0 ? filteredOut / totalComments : 0;

        if (noiseRatio > 0.5 && totalComments >= 4) {
          console.log(`reply_blacklist: post=${post.post_id.slice(0, 8)}, noise=${(noiseRatio * 100).toFixed(0)}%, filtered=${filteredOut}/${totalComments}`);
          await blacklistThread(env.DB, post.post_id, `noise_ratio_${noiseRatio.toFixed(2)}`, 24);
          continue;
        }

        // Catalog any flagged agent instruction attacks
        for (const flagged of filterResult.flaggedForCatalog) {
          const authorId = flagged.comment.author?.id || 'unknown';
          await addToCollection(
            env.DB,
            flagged.attackType,
            flagged.reason,
            2, // severity
            authorId,
            JSON.stringify({ comment_id: flagged.comment.id, content: flagged.comment.content.slice(0, 100) })
          );
          console.log(`reply_catalog: type=${flagged.attackType}, reason=${flagged.reason}`);
        }

        if (filterResult.filteredComments.length > 0) {
          filteredPosts.push({
            post,
            comments: filterResult.filteredComments,
            effectiveThreshold: filterResult.effectiveThreshold,
          });
        }
      }

      // Queue worthy comments using dynamic threshold from velocity check
      let totalQueued = 0;
      for (const { post, comments, effectiveThreshold } of filteredPosts) {
        const queued = await queueWorthyComments(
          env.DB,
          [{ post, comments }],
          effectiveThreshold,
          'H0BBOT'
        );
        totalQueued += queued;
      }

      if (totalQueued > 0) {
        console.log(`reply_queue: queued=${totalQueued}`);
      }

      // Process reply queue with iteration budget (20% = 2 replies max per cycle)
      const maxReplies = Math.max(1, remainingBudget.replies);
      const repliesPosted = await processReplyQueue(
        moltbookClient,
        env.DB,
        layer2Provider,
        maxReplies,
        memoryContext
      );
      cycleCollector.repliesSent += repliesPosted;

      console.log(`reply_phase: complete, sent=${repliesPosted}`);
    }

    // 8. Comment processing phase (only if budget allows)
    let processedCount = 0;
    let engagedCount = 0;
    let catalogedCount = 0;
    let failedCount = 0;

    if (!canComment) {
      console.log('comment_phase: skip, reason=budget_exhausted');
    } else {
      // Discover unseen posts using personalized feed
      let discovered = await discoverPosts(moltbookClient, env.DB, cycleIndex, true, context);
      console.log(`discovery: posts=${discovered.length}`);
      cycleCollector.postsDiscovered = discovered.length;

      // Fallback: if discovery yielded low results, run semantic probe
      if (discovered.length < PROBE_FALLBACK_THRESHOLD) {
        try {
          const probeResults = await runSemanticProbe(
            moltbookClient, env.DB,
            PROBE_FALLBACK_THRESHOLD - discovered.length
          );
          if (probeResults.length > 0) {
            const existingIds = new Set(discovered.map(d => d.post.id));
            const newProbes = probeResults.filter(p => !existingIds.has(p.post.id));
            discovered = [...discovered, ...newProbes];
            console.log(`probe_fallback: added=${newProbes.length}, total=${discovered.length}`);
          }
        } catch (error) {
          console.error('probe_fallback: failed', error);
        }
      }

      // Limit posts per run
      if (discovered.length > PROCESSING_LIMITS.MAX_SHAPES_PER_RUN) {
        console.log(`discovery: capped=${PROCESSING_LIMITS.MAX_SHAPES_PER_RUN}`);
        discovered = discovered.slice(0, PROCESSING_LIMITS.MAX_SHAPES_PER_RUN);
      }

      // Track timing for comment spacing (21s between consecutive comments)
      let lastCommentTime = 0;

      // Track profile fetches per cycle (cap at MAX_PROFILE_FETCHES_PER_CYCLE)
      let profileFetchCount = 0;

      // Track context-driven stats
      let contextBoosts = 0;
      let contextPenalties = 0;
      let gatesFromContext = 0;

      // Observation buffers: accumulate D1 writes, flush as single batch after loop
      const platformSignalBuffer: PlatformSignalEntry[] = [];
      const shapeObservationBuffer: ShapeObservationEntry[] = [];
      const engagementPatternBuffer: EngagementPatternEntry[] = [];

      // Process each post
      for (const { post, source: discoverySource } of discovered) {
      // Decision trace — built incrementally, written with markAsSeen
      const trace = startTrace(post, discoverySource);

      try {
        // Check if we still have budget (in case we hit limit mid-loop)
        const currentBudget = await getTodayBudget(env.DB);
        incrementSubrequestCount(1); // D1: budget check
        if (currentBudget.comments_used >= currentBudget.comments_max) {
          console.log('comment_loop: break, reason=budget_exhausted');
          break;
        }

        // Subrequest safety: stop before hitting Cloudflare's 1,000 limit
        if (isNearSubrequestLimit()) {
          console.log(`comment_loop: break, reason=subrequest_limit, count=${getSubrequestCount()}/1000`);
          break;
        }

        // Skip posts with null authors (deleted users)
        if (!post.author) {
          console.log(`post_skip: id=${post.id.slice(0, 8)}, gate=no_author`);
          trace.gate = 'no_author';
          platformSignalBuffer.push({ signalKey: `gate_hit:no_author`, examplePostId: post.id });
          continue;
        }

        // Check whitelist first
        const authorName = post.author.name || post.author.username || 'unknown';

        // Skip own posts (don't comment on self)
        if (authorName.toLowerCase() === 'h0bbot') {
          console.log(`post_skip: id=${post.id.slice(0, 8)}, gate=own_post`);
          trace.gate = 'own_post';
          await markAsSeen(env.DB, post.id, 0, undefined, discoverySource, trace, post.submolt);
          platformSignalBuffer.push({ signalKey: `gate_hit:own_post`, examplePostId: post.id });
          continue;
        }

        // Thread blacklist check (sticky skip across cycles)
        if (await isBlacklisted(env.DB, post.id)) {
          trace.gate = 'blacklisted';
          await markAsSeen(env.DB, post.id, 0, undefined, discoverySource, trace, post.submolt);
          processedCount++;
          continue;
        }

        if (isWhitelisted(authorName)) {
          console.log(`post_skip: id=${post.id.slice(0, 8)}, gate=whitelisted, author=${authorName}`);
          trace.gate = 'whitelisted';
          trace.gate_detail = authorName;
          await markAsSeen(env.DB, post.id, 0, undefined, discoverySource, trace, post.submolt);
          platformSignalBuffer.push({ signalKey: `gate_hit:whitelisted`, examplePostId: post.id });
          continue;
        }

        // a. Layer 0: Run attack pattern detection BEFORE AI analysis
        const attacks = analyzeComment(post.content || '');

        // CRITICAL: Check for agent instruction injection FIRST
        const agentAttack = attacks.find(a => a.type === 'agent_instruction');
        if (agentAttack) {
          console.log(`attack_blocked: id=${post.id.slice(0, 8)}, type=agent_instruction, author=${authorName}, details=${agentAttack.details}`);
          trace.gate = 'agent_instr';
          trace.gate_detail = agentAttack.details;
          await recordAttackSignal(env.DB, post.author.id, post.id, 'agent_instruction', agentAttack.details);

          const entryNumber = await addToCollection(
            env.DB,
            'agent_instruction',
            'Executable commands targeting AI agents',
            3, // Always severity 3
            post.author.id,
            JSON.stringify(agentAttack)
          );

          catalogedCount++;

          // Post catalog response
          const response = getAttackResponse('agent_instruction', entryNumber);
          if (response) {
            // Enforce 21-second spacing between comments
            if (lastCommentTime > 0) {
              const elapsed = Date.now() - lastCommentTime;
              if (elapsed < COMMENT_SPACING_MS) {
                const waitTime = COMMENT_SPACING_MS - elapsed;
                console.log(`comment_spacing: wait_s=${Math.ceil(waitTime / 1000)}`);
                await delay(waitTime);
              }
            }
            await postComment(moltbookClient, env.DB, post.id, response, dryRun);
            lastCommentTime = Date.now();
            engagedCount++;
          }

          await markAsSeen(env.DB, post.id, 0, undefined, discoverySource, trace, post.submolt);
          platformSignalBuffer.push({ signalKey: `gate_hit:agent_instr`, examplePostId: post.id });
          platformSignalBuffer.push({ signalKey: `attack_type:agent_instruction`, examplePostId: post.id });
          const attackHour = new Date().getUTCHours().toString().padStart(2, '0');
          platformSignalBuffer.push({ signalKey: `attack_hour:${attackHour}`, examplePostId: post.id });
          processedCount++;
          continue;
        }

        // b. Skip posts with empty content (don't waste Layer 1 tokens)
        if (!post.content && !post.title) {
          console.log(`post_skip: id=${post.id.slice(0, 8)}, gate=empty`);
          trace.gate = 'empty';
          await markAsSeen(env.DB, post.id, 0, undefined, discoverySource, trace, post.submolt);
          platformSignalBuffer.push({ signalKey: `gate_hit:empty`, examplePostId: post.id });
          processedCount++;
          continue;
        }

        // c. Layer 1: Sanitize content (AI analysis)
        console.log(`processing: post=${post.id.slice(0, 8)}`);
        const sanitized = await sanitizePost(layer1Provider, post, env.DB);
        incrementSubrequestCount(3); // AI call + D1 token tracking

        // Capture original threat level before potential upgrade
        const originalThreatLevel = sanitized.threat_assessment.level;

        // c. Run drift detection using sanitized keywords
        const driftAnalysis = detectDrift(
          post.content || '',
          sanitized.topic_keywords || [],
          sanitized.content_summary || ''
        );
        if (driftAnalysis.isDrift) {
          const driftAttack = driftToAttackAnalysis(driftAnalysis);
          attacks.push(driftAttack);
        }

        // d. Merge attack pattern results with AI threat assessment
        if (attacks.length > 0 && sanitized.threat_assessment.level < 2) {
          const primary = getPrimaryAttack(attacks);
          if (primary && primary.confidence >= 60) {
            // Upgrade threat level based on attack patterns
            sanitized.threat_assessment.level = 2;
            sanitized.threat_assessment.attack_geometry = primary.type ?? 'unknown';
            sanitized.threat_assessment.signals.push(
              ...attacks.map(a => `${a.type}: ${a.details}`)
            );
            console.log(`attack_detected: post=${post.id.slice(0, 8)}, type=${primary.type}, confidence=${primary.confidence}`);
          }
        }

        // Populate trace sanitizer block
        trace.san = {
          threat: sanitized.threat_assessment.level,
          shape: sanitized.structural_shape,
          shape_conf: sanitized.shape_confidence,
          intent: sanitized.detected_intent,
          sigs: Object.entries(sanitized.engagement_signals)
            .filter(([_, v]) => v === true)
            .map(([k]) => k),
        };

        // Populate trace attack block
        if (attacks.length > 0) {
          const primaryAtk = getPrimaryAttack(attacks);
          trace.atk = {
            n: attacks.length,
            types: [...new Set(attacks.map(a => a.type).filter(Boolean))] as string[],
            primary: primaryAtk?.type ?? undefined,
            conf: primaryAtk?.confidence,
            escalated: sanitized.threat_assessment.level > originalThreatLevel,
          };
        }

        // Record attack signal if detected
        if (attacks.length > 0) {
          const primary = getPrimaryAttack(attacks);
          if (primary && primary.type) {
            await recordAttackSignal(
              env.DB,
              sanitized.author_hash,
              post.id,
              primary.type,
              primary.details
            );
            // Platform signals: attack type and temporal
            platformSignalBuffer.push({ signalKey: `attack_type:${primary.type}`, examplePostId: post.id });
            const attackHour = new Date().getUTCHours().toString().padStart(2, '0');
            platformSignalBuffer.push({ signalKey: `attack_hour:${attackHour}`, examplePostId: post.id });
          }
        }

        // f. Score engagement (with context-driven adjustments)
        const authorHashHex = await hashContent(sanitized.author_hash);
        const { score, signals } = scoreTarget(sanitized, context, {
          authorHashHex,
          authorName,
        });
        console.log(`scored: post=${post.id.slice(0, 8)}, score=${score}, threat=${sanitized.threat_assessment.level}`);

        // Count context-driven signal hits
        if (signals.ctx_constructive_agent && signals.ctx_constructive_agent > 0) contextBoosts++;
        if (signals.ctx_followed_agent && signals.ctx_followed_agent > 0) contextBoosts++;
        if (signals.ctx_resonant_shape && signals.ctx_resonant_shape > 0) contextBoosts++;
        if (signals.ctx_hostile_agent && signals.ctx_hostile_agent < 0) contextPenalties++;
        if (signals.ctx_bot_submolt && signals.ctx_bot_submolt < 0) contextPenalties++;

        // Context gate: Skip engagement in suppressed submolts (except exceptional posts)
        if (context?.suppressedSubmolts.has(post.submolt) && score < 85) {
          const submoltInfo = context.submoltHealth.get(post.submolt);
          trace.out = {
            action: 'skip',
            reason: `suppressed submolt (bot density ${submoltInfo?.botDensity?.toFixed(2) ?? '?'})`,
            upvoted: false,
            profile_fetched: false,
          };
          await markAsSeen(env.DB, post.id, score, signals, discoverySource, trace, post.submolt);
          platformSignalBuffer.push({ signalKey: `gate_hit:ctx_suppressed_submolt`, examplePostId: post.id });
          gatesFromContext++;
          processedCount++;
          continue;
        }

        // Context gate: Raise threshold during peak attack hours
        if (context?.peakAttackHours.has(new Date().getUTCHours())) {
          const raisedThreshold = SCORING_THRESHOLDS.COMMENT + 10;
          if (score < raisedThreshold && score >= SCORING_THRESHOLDS.COMMENT) {
            trace.out = {
              action: 'skip',
              reason: `peak attack hour, raised threshold to ${raisedThreshold}`,
              upvoted: false,
              profile_fetched: false,
            };
            await markAsSeen(env.DB, post.id, score, signals, discoverySource, trace, post.submolt);
            platformSignalBuffer.push({ signalKey: `gate_hit:ctx_peak_hour`, examplePostId: post.id });
            gatesFromContext++;
            processedCount++;
            continue;
          }
        }

        // Log shape classification if confident
        if (sanitized.structural_shape && sanitized.shape_confidence && sanitized.shape_confidence >= 60) {
          console.log(`classified: post=${post.id.slice(0, 8)}, shape=${sanitized.structural_shape}, confidence=${sanitized.shape_confidence}`);
          // Record shape observation
          shapeObservationBuffer.push({ shapeName: sanitized.structural_shape, examplePostId: post.id });
        }

        // Record engagement signal patterns
        if (sanitized.engagement_signals.seeking_help) {
          engagementPatternBuffer.push({ patternType: 'seeking_help', examplePostId: post.id });
        }
        if (sanitized.engagement_signals.structural_language) {
          engagementPatternBuffer.push({ patternType: 'structural_language', examplePostId: post.id });
        }
        if (sanitized.engagement_signals.creative_attempt) {
          engagementPatternBuffer.push({ patternType: 'creative_attempt', examplePostId: post.id });
        }

        // Platform signals: submolt traffic + bot detection + content velocity
        platformSignalBuffer.push({ signalKey: `submolt_traffic:${post.submolt}`, examplePostId: post.id });
        platformSignalBuffer.push({ signalKey: `source_seen:${discoverySource}`, examplePostId: post.id });
        if (sanitized.threat_assessment.level >= 1 || attacks.length > 0) {
          platformSignalBuffer.push({ signalKey: `submolt_bots:${post.submolt}`, examplePostId: post.id });
        }
        const ageBucket = trace.age_m < 30 ? '0-30m' : trace.age_m < 60 ? '30-60m' : trace.age_m < 360 ? '1-6h' : '6h+';
        platformSignalBuffer.push({ signalKey: `content_velocity:${ageBucket}`, examplePostId: post.id });

        // g. Upvote quality posts (score >= 70, no threats)
        let upvoted = false;
        let profileFetched = false;
        if (score >= 70 && sanitized.threat_assessment.level === 0) {
          const upvoteResult = await upvoteAndTrackAuthor(
            moltbookClient,
            env.DB,
            post,
            score,
            dryRun
          );
          incrementSubrequestCount(4); // API call + D1: hasUpvoted + upvotes_given + followed_authors
          if (upvoteResult.upvoted) {
            console.log(`upvoted: post=${post.id.slice(0, 8)}`);
            upvoted = true;
          }

          // Capture agent profile for quality authors
          if (post.author) {
            try {
              // Basic profile from post.author (no API call)
              await upsertAgentProfile(env.DB, post.author, score);

              // Rich profile fetch for high-value authors (score >= 80)
              if (score >= 80 &&
                  profileFetchCount < MAX_PROFILE_FETCHES_PER_CYCLE &&
                  await isProfileStale(env.DB, post.author.id)) {
                const authorName = post.author.name || post.author.username || post.author.id;
                const profile = await moltbookClient.getProfile(authorName);
                await upsertAgentProfile(env.DB, profile, score);
                profileFetchCount++;
                profileFetched = true;
                console.log(`profile_fetched: author=${authorName}`);
              }
            } catch (error) {
              // Profile capture is non-critical
            }
          }
        }

        // CRITICAL: Check for parse failures and skip
        if (sanitized.parse_failed) {
          console.log(`post_skip: id=${post.id.slice(0, 8)}, gate=parse_failed`);
          trace.gate = 'parse_fail';
          await markAsSeen(env.DB, post.id, score, signals, discoverySource, trace, post.submolt);
          platformSignalBuffer.push({ signalKey: `gate_hit:parse_fail`, examplePostId: post.id });
          processedCount++;
          continue; // Don't catalog, don't engage, just move on
        }

        // CRITICAL: Skip engagement if content_summary is unclear (don't waste Layer 2 tokens)
        const unclearSummaries = ['Unknown content', 'unavailable', 'Parse failed', ''];

        // Only skip if summary is completely missing or is a known error placeholder
        // Removed overly-broad "unknown" substring check that was blocking valid summaries
        if (!sanitized.content_summary ||
            sanitized.content_summary.trim() === '' ||
            unclearSummaries.includes(sanitized.content_summary)) {
          console.log(`post_skip: id=${post.id.slice(0, 8)}, gate=content_unclear`);
          trace.gate = 'content_unclear';
          await markAsSeen(env.DB, post.id, score, signals, discoverySource, trace, post.submolt);
          platformSignalBuffer.push({ signalKey: `gate_hit:content_unclear`, examplePostId: post.id });
          processedCount++;
          continue;
        }

        processedCount++;

        // d. Check for extraction attempts and handle escalation
        if (sanitized.threat_assessment.level === 2 &&
            sanitized.threat_assessment.attack_geometry &&
            ['extraction_probe', 'meta_fishing', 'framework_mining'].includes(
              sanitized.threat_assessment.attack_geometry
            )) {

          // Check if this author has previous signals
          const recentExtractions = await getRecentSignalCount(
            env.DB,
            sanitized.author_hash,
            24
          );

          if (recentExtractions >= 1) {
            // Repeated extraction - escalate to threat 3
            console.log(`escalation: post=${post.id.slice(0, 8)}, type=persistent_extraction`);
            sanitized.threat_assessment.level = 3;
            sanitized.threat_assessment.attack_geometry = 'persistent_extraction';

            // Continue to catalog logic below
          } else {
            // First extraction - deflect
            console.log(`deflection: post=${post.id.slice(0, 8)}, type=${sanitized.threat_assessment.attack_geometry}`);
            trace.out = { action: 'deflect', reason: `first extraction probe: ${sanitized.threat_assessment.attack_geometry}` };

            // Record this author signal
            await recordAuthorSignal(env.DB, sanitized.author_hash, post.id);

            // Generate deflection response
            const deflection = await generateDeflectionResponse(
              layer2Provider,
              sanitized,
              env.DB,
              trace,
              memoryContext
            );

            // Guard: skip if response too short
            if (!deflection || deflection.trim().length === 0) {
              console.log(`deflection_skip: post=${post.id.slice(0, 8)}, reason=empty_response`);
              trace.out.action = 'skip';
              trace.out.reason = 'deflection_too_thin';
              await markAsSeen(env.DB, post.id, score, signals, discoverySource, trace, post.submolt);
              continue;
            }

            console.log(`deflection_response: post=${post.id.slice(0, 8)}, len=${deflection.length}`);

            // Post deflection (with spacing)
            if (lastCommentTime > 0) {
              const elapsed = Date.now() - lastCommentTime;
              if (elapsed < COMMENT_SPACING_MS) {
                const waitTime = COMMENT_SPACING_MS - elapsed;
                console.log(`comment_spacing: wait_s=${Math.ceil(waitTime / 1000)}`);
                await delay(waitTime);
              }
            }
            await postComment(
              moltbookClient,
              env.DB,
              post.id,
              deflection,
              dryRun
            );
            lastCommentTime = Date.now();

            engagedCount++;
            recordNotableInteraction(cycleCollector, {
              postId: post.id, submolt: post.submolt, authorHash: sanitized.author_hash,
              authorName, score, action: 'deflected', threatLevel: sanitized.threat_assessment.level,
              shape: sanitized.structural_shape, topics: sanitized.topic_keywords,
              contentSummary: sanitized.content_summary?.slice(0, 100),
            });
            await markAsSeen(env.DB, post.id, score, signals, discoverySource, trace, post.submolt);
            platformSignalBuffer.push({ signalKey: `source_engaged:${discoverySource}`, examplePostId: post.id });
            continue; // Don't do normal engagement or cataloging
          }
        }

        // e. If threat_level >= 2: Catalog and respond
        if (sanitized.threat_assessment.level >= 2) {
          const attackGeometry = sanitized.threat_assessment.attack_geometry ?? 'unknown';
          console.log(`catalog: post=${post.id.slice(0, 8)}, threat=${sanitized.threat_assessment.level}, geometry=${attackGeometry}`);
          trace.out = { action: 'catalog', reason: `threat_level_${sanitized.threat_assessment.level}: ${attackGeometry}` };

          const entryNumber = await addToCollection(
            env.DB,
            attackGeometry,
            sanitized.content_summary,
            sanitized.threat_assessment.level,
            sanitized.author_hash,
            JSON.stringify(sanitized.threat_assessment.signals)
          );

          catalogedCount++;

          // Check if this attack type should get a posted response
          // Some types (symbol_noise, low_effort_noise, etc.) are catalog-only
          if (!shouldRespondToAttack(attackGeometry as import('./pipeline/attack-patterns').AttackType)) {
            console.log(`catalog_silent: post=${post.id.slice(0, 8)}, type=${attackGeometry}`);
            trace.out.reason += ' (catalog-only, no response)';
            await markAsSeen(env.DB, post.id, score, signals, discoverySource, trace, post.submolt);
            continue;
          }

          // Generate catalog response
          const catalogResponse = await generateCatalogResponse(
            layer2Provider,
            sanitized,
            entryNumber,
            env.DB,
            trace,
            memoryContext
          );

          // Guard: skip if response too short
          if (!catalogResponse || catalogResponse.trim().length === 0) {
            console.log(`catalog_skip: post=${post.id.slice(0, 8)}, reason=empty_response`);
            await markAsSeen(env.DB, post.id, score, signals, discoverySource, trace, post.submolt);
            continue;
          }

          console.log(`catalog_response: post=${post.id.slice(0, 8)}, len=${catalogResponse.length}`);

          // Post catalog comment (with spacing)
          if (lastCommentTime > 0) {
            const elapsed = Date.now() - lastCommentTime;
            if (elapsed < COMMENT_SPACING_MS) {
              const waitTime = COMMENT_SPACING_MS - elapsed;
              console.log(`comment_spacing: wait_s=${Math.ceil(waitTime / 1000)}`);
              await delay(waitTime);
            }
          }
          await postComment(
            moltbookClient,
            env.DB,
            post.id,
            catalogResponse,
            dryRun
          );
          lastCommentTime = Date.now();

          engagedCount++;
          recordNotableInteraction(cycleCollector, {
            postId: post.id, submolt: post.submolt, authorHash: sanitized.author_hash,
            authorName, score, action: 'cataloged', threatLevel: sanitized.threat_assessment.level,
            shape: sanitized.structural_shape, topics: sanitized.topic_keywords,
            contentSummary: sanitized.content_summary?.slice(0, 100),
          });
          await markAsSeen(env.DB, post.id, score, signals, discoverySource, trace, post.submolt);
          platformSignalBuffer.push({ signalKey: `source_engaged:${discoverySource}`, examplePostId: post.id });
          continue; // Don't do normal engagement for attacks
        }

        // f. If score >= 60 and budget allows: Generate response and comment
        if (isCommentWorthy(score)) {
          console.log(`engaging: post=${post.id.slice(0, 8)}, score=${score}`);
          trace.out = { action: 'engage', reason: `score ${score} >= threshold`, upvoted, profile_fetched: profileFetched };

          const response = await generateResponse(
            layer2Provider,
            sanitized,
            score,
            env.DB,
            trace,
            memoryContext
          );
          incrementSubrequestCount(2); // AI call + D1 token log

          // Guard: skip if response too short
          if (!response || response.trim().length === 0) {
            console.log(`engage_skip: post=${post.id.slice(0, 8)}, reason=empty_response`);
            trace.out.action = 'skip';
            trace.out.reason = 'response_rejected';
            await markAsSeen(env.DB, post.id, score, signals, discoverySource, trace, post.submolt);
            continue;
          }

          console.log(`engage_response: post=${post.id.slice(0, 8)}, len=${response.length}`);

          // Post comment (with spacing)
          if (lastCommentTime > 0) {
            const elapsed = Date.now() - lastCommentTime;
            if (elapsed < COMMENT_SPACING_MS) {
              const waitTime = COMMENT_SPACING_MS - elapsed;
              console.log(`comment_spacing: wait_s=${Math.ceil(waitTime / 1000)}`);
              await delay(waitTime);
            }
          }
          const posted = await postComment(
            moltbookClient,
            env.DB,
            post.id,
            response,
            dryRun
          );
          incrementSubrequestCount(4); // API call + D1: audit + budget + seen
          lastCommentTime = Date.now();

          if (posted) {
            engagedCount++;
            recordNotableInteraction(cycleCollector, {
              postId: post.id, submolt: post.submolt, authorHash: sanitized.author_hash,
              authorName, score, action: 'engaged', threatLevel: sanitized.threat_assessment.level,
              shape: sanitized.structural_shape, topics: sanitized.topic_keywords,
              contentSummary: sanitized.content_summary?.slice(0, 100),
            });
            platformSignalBuffer.push({ signalKey: `source_engaged:${discoverySource}`, examplePostId: post.id });
          }
        } else {
          // Below comment threshold — record skip with reason
          trace.out = {
            action: score >= 70 ? 'upvote_only' : 'skip',
            reason: `score ${score} below comment threshold`,
            upvoted,
            profile_fetched: profileFetched,
          };

          // Blacklist clearly low-quality posts to prevent re-evaluation
          if (score < 30) {
            await blacklistThread(env.DB, post.id, `low_score_${score}`, 24);
          }
        }

        // Write final trace for all non-early-exit paths
        await markAsSeen(env.DB, post.id, score, signals, discoverySource, trace, post.submolt);

        // Learning loop: extract patterns (skip in conservation mode)
        if (tokenMode === 'full' && sanitized && !sanitized.parse_failed) {
          const didEngage = trace.out?.action === 'engage' || trace.out?.action === 'catalog' || trace.out?.action === 'deflect';
          try {
            await maybeExtractPatterns(layer1Provider, env.DB, sanitized, score, attacks, didEngage, authorName);
            incrementSubrequestCount(3); // AI call + D1 pattern writes
          } catch (err) {
            console.error('pattern_extraction: failed', err);
          }
        }
      } catch (error) {
        const postIdPrefix = post?.id ? String(post.id).slice(0, 8) : 'unknown';
        if (error instanceof GeminiLocationError) {
          console.error(`post_error: id=${postIdPrefix}, type=location_blocked`, error.message);
          processedCount++;
          continue;
        }
        // Permanent diagnostics: log field types on D1 errors
        if (error instanceof Error && error.message.includes('D1_TYPE_ERROR')) {
          const postFields = Object.entries(post)
            .filter(([_, v]) => v !== null && typeof v !== 'undefined')
            .map(([k, v]) => `${k}:${typeof v}`)
            .join(', ');
          console.error(`D1 type error on post ${postIdPrefix}. Post fields: ${postFields}`);
          if (post?.author) {
            const authorFields = Object.entries(post.author)
              .map(([k, v]) => `${k}:${typeof v}`)
              .join(', ');
            console.error(`Author fields: ${authorFields}`);
          }
        }
        console.error(`post_error: id=${postIdPrefix}`, error);
        failedCount++;
      }
    }

    // Flush observation buffers (batch D1 writes: N calls -> 1 per type)
    if (platformSignalBuffer.length > 0) {
      await recordPlatformSignalsBatch(env.DB, platformSignalBuffer);
      incrementSubrequestCount(1);
    }
    if (shapeObservationBuffer.length > 0) {
      await recordShapeObservationsBatch(env.DB, shapeObservationBuffer);
      incrementSubrequestCount(1);
    }
    if (engagementPatternBuffer.length > 0) {
      await recordEngagementPatternsBatch(env.DB, engagementPatternBuffer);
      incrementSubrequestCount(1);
    }

    console.log(`comment_phase: complete, processed=${processedCount}, engaged=${engagedCount}, cataloged=${catalogedCount}, failed=${failedCount}${contextBoosts > 0 || contextPenalties > 0 || gatesFromContext > 0 ? `, ctx_boosts=${contextBoosts}, ctx_penalties=${contextPenalties}, ctx_gates=${gatesFromContext}` : ''}`);

    // Populate cycle collector with comment phase totals
    cycleCollector.postsEngaged += engagedCount;
    cycleCollector.attacksCataloged += catalogedCount;
    cycleCollector.postsFailed += failedCount;

    // Record cycle summary for longitudinal tracking
    if (context) {
      try {
        await recordCycleSummary(env.DB, context, {
          postsDiscovered: discovered.length,
          postsEngaged: engagedCount,
          postsSkipped: processedCount - engagedCount - catalogedCount,
          attacksCataloged: catalogedCount,
          contextBoosts,
          contextPenalties,
          gatesFromContext,
        });
      } catch (err) {
        console.error('cycle_summary: recording_failed', err);
      }
    }
  }

    // 9. Follow opportunity check - runs at end of hour (no AI calls, budget-capped)
    if (cycleIndex === 3) {
      try {
        const followed = await checkForFollowOpportunity(moltbookClient, env.DB, dryRun);
        if (followed.length > 0) {
          console.log(`follow_phase: followed=${followed.length}, authors=${followed.join(', ')}`);
        }
      } catch (error) {
        console.error('follow_phase: failed', error);
      }
    }

    // 9.5. Hourly maintenance (runs once per hour, first cycle)
    const currentMinutes = new Date().getUTCMinutes();
    if (currentMinutes < 15) {
      // Duplicate cleanup (all modes, no AI calls)
      try {
        const cleanupResult = await cleanupDuplicatePosts(moltbookClient, env.DB);
        if (cleanupResult.deleted > 0) {
          console.log(`cleanup: deleted=${cleanupResult.deleted} duplicates`);
        }
        if (cleanupResult.errors.length > 0) {
          console.log(`cleanup_errors: ${cleanupResult.errors.join('; ')}`);
        }
      } catch (error) {
        console.error('cleanup: failed', error);
      }

      // Full mode: reflect + pattern maintenance + digest + memory reflection
      if (tokenMode === 'full') {
        console.log('reflect_phase: starting');
        try {
          const reflectResult = await runReflectPhase(env.DB, moltbookClient);
          console.log(`reflect_phase: outcomes=${reflectResult.outcomes_checked}, anomalies=${reflectResult.anomalies.length}`);

          for (const anomaly of reflectResult.anomalies) {
            console.log(`reflect_anomaly: severity=${anomaly.severity}, type=${anomaly.type}, desc=${anomaly.description}`);
          }
        } catch (error) {
          console.error('reflect_phase: failed', error);
        }

        // Pattern maintenance and digest rebuild (LLM calls)
        try {
          const retired = await retireStalePatterns(env.DB);
          if (retired > 0) console.log(`pattern_maintenance: retired=${retired}`);

          const archived = await archiveAncientPatterns(env.DB);
          if (archived > 0) console.log(`pattern_maintenance: archived=${archived}`);

          if (await shouldRebuildDigest(env.DB)) {
            console.log('digest_rebuild: starting');
            const digestResult = await rebuildDigest(layer1Provider, env.DB);
            if (digestResult.rebuilt) {
              knowledgeDigest = await loadDigest(env.DB);
              const freshMemCtx = await buildMemoryContext(env.DB, knowledgeDigest);
              memoryContext = formatMemoryForPrompt(freshMemCtx);
              console.log(`digest_rebuild: complete, patterns=${digestResult.patternCount}`);
            }
          }
        } catch (err) {
          console.error('pattern_maintenance: failed', err);
        }

        // Memory reflection: synthesize cycle learnings (LLM call)
        const events = getCycleEvents(cycleCollector);
        if (events.postsDiscovered > 0 || events.repliesSent > 0) {
          try {
            const reflectionResult = await runMemoryReflection(env.DB, layer1Provider, events);
            console.log(`memory_reflection: summary="${reflectionResult.learningSummary.slice(0, 80)}", updates=${reflectionResult.knowledgeUpdates}`);
          } catch (err) {
            console.error('memory_reflection: failed', err);
          }
        }

        // Sovereign territory check (seed new territories if needed)
        try {
          const sovereignResult = await runSovereignCheck(moltbookClient, env.DB, dryRun);
          if (sovereignResult.created > 0 || sovereignResult.seeded > 0) {
            console.log(`sovereign_check: created=${sovereignResult.created}, seeded=${sovereignResult.seeded}`);
          }
          if (sovereignResult.errors.length > 0) {
            console.log(`sovereign_errors: ${sovereignResult.errors.join('; ')}`);
          }
        } catch (error) {
          if (error instanceof Error && error.name === 'RateLimitError') {
            const minCooldown = 35 * 60;
            const retryAfter = Math.max((error as any).retryAfter ?? 0, minCooldown);
            await setRateLimitedUntil(env.DB, retryAfter, '/posts');
            console.log(`sovereign_check: rate_limited, cooldown=${retryAfter}s`);
          } else {
            console.error('sovereign_check: failed', error);
          }
        }
      }

      // Both full and reduced: cheap D1 maintenance
      const expiredBlacklist = await cleanExpiredBlacklist(env.DB);
      if (expiredBlacklist > 0) console.log(`blacklist_cleanup: expired=${expiredBlacklist}`);

      try {
        const decayed = await decayStaleKnowledge(env.DB);
        if (decayed > 0) console.log(`memory_maintenance: decayed=${decayed}`);
        const pruned = await pruneDeadKnowledge(env.DB);
        if (pruned > 0) console.log(`memory_maintenance: pruned=${pruned}`);
      } catch (err) {
        console.error('memory_maintenance: failed', err);
      }
    }

    // 10. Post generation phase (full mode only)
    if (tokenMode === 'full' && canPost) {
      // Check API rate-limit state before attempting any posts
      const rateLimited = await isRateLimited(env.DB);
      if (rateLimited) {
        console.log('post_phase: skip, reason=rate_limited');
      } else {
      try {
        // Phase 6: Try glossary post first (once per 24 hours)
        const glossaryResult = await maybePostGlossaryEntry(moltbookClient, env.DB, dryRun);
        if (glossaryResult.posted) {
          // Track in budget if actually posted
          if (glossaryResult.postId) {
            const glossaryTitleHash = await hashContent('Glossary Entry');
            const glossaryTrace = JSON.stringify({
              ts: new Date().toISOString(),
              src: 'generate',
              sub: 'structured-minds',
              age_m: 0,
              cmts: 0,
              out: { action: 'post', reason: 'glossary entry', has_anchor: true },
            });
            await trackOwnPost(env.DB, glossaryResult.postId, 'structured-minds', 'Glossary Entry', glossaryTitleHash, glossaryTrace);
            await recordPost(env.DB);
          }
          // Skip regular post this cycle to avoid rate limits
          console.log('post_phase: glossary_posted, skip_regular=true');
        }

        // Only attempt regular post if glossary didn't just post
        if (!glossaryResult.posted) {
        const timeSinceLastPost = await getTimeSinceLastPost(env.DB);
        const hoursSincePost = timeSinceLastPost / 60; // Convert minutes to hours

        // Attempt post every 4+ hours
        if (hoursSincePost >= BUDGET.POST_COOLDOWN_HOURS) {
        console.log('post_phase: starting');

        // Get relevant submolts (score >= 60)
        let relevantSubmolts = await getRelevantSubmolts(env.DB, POST_GENERATION.MIN_SUBMOLT_RELEVANCE);

        // FALLBACK: If no submolts found, seed 'general' as default
        if (relevantSubmolts.length === 0) {
          console.log('post_phase: seeding_default_submolt');
          await env.DB.prepare(`
            INSERT OR REPLACE INTO submolts (name, description, member_count, relevance_score, updated_at)
            VALUES ('general', 'General discussion', 0, 100, datetime('now'))
          `).run();

          // Re-query to get the newly seeded submolt
          relevantSubmolts = await getRelevantSubmolts(env.DB, POST_GENERATION.MIN_SUBMOLT_RELEVANCE);
        }

        if (relevantSubmolts.length > 0) {
          // Select submolt (random from eligible for diversity)
          const targetSubmolt = selectSubmolt(relevantSubmolts);

          if (targetSubmolt) {
            console.log(`post_phase: target_submolt=${targetSubmolt.name}`);

            // Generate post
            const generatedPost = await generatePost(
              layer2Provider,
              targetSubmolt,
              env.DB,
              undefined,
              memoryContext
            );

            console.log(`post_generated: title="${generatedPost.title}"`);

            // Anchor check (only meaningful for essays; templates are metaphorical by design)
            const anchored = generatedPost.postType === 'essay'
              ? hasConcreteAnchor(generatedPost.content)
              : true;
            if (!anchored) {
              console.log('post_validate: anchor_check=failed');
            }
            const postTrace = {
              ts: new Date().toISOString(),
              src: 'generate',
              sub: generatedPost.submolt,
              age_m: 0,
              cmts: 0,
              out: {
                action: 'post',
                reason: `${generatedPost.metaphorFamily} post`,
                family: generatedPost.metaphorFamily,
                has_anchor: anchored,
                ...(!anchored ? { val_fail: 'no_concrete_anchor' } : {}),
              },
            };

            // Submit post (own_posts tracking happens inside createPost)
            const result = await createPost(
              moltbookClient,
              env.DB,
              generatedPost.title,
              generatedPost.content,
              generatedPost.submolt,
              dryRun,
              { decisionLog: JSON.stringify(postTrace) }
            );

            if (result.success) {
              if (result.post_id) {
                console.log(`post_phase: published, id=${result.post_id}`);
              }
              await recordSubmoltPost(env.DB, targetSubmolt.name);
            }
          }
        } else {
          console.log('post_phase: skip, reason=no_relevant_submolts');
        }
      } else {
        const minutesRemaining = (BUDGET.POST_COOLDOWN_HOURS * 60) - timeSinceLastPost;
        console.log(`post_phase: cooldown, remaining_min=${Math.floor(minutesRemaining)}`);
      }
        } // Close if (!glossaryResult.posted)
    } catch (error) {
      // Persist rate limit state if a 429 bubbled up (e.g. from glossary)
      if (error instanceof Error && error.name === 'RateLimitError') {
        const minCooldown = 35 * 60; // POST_INTERVAL_MINUTES
        const retryAfter = Math.max((error as any).retryAfter ?? 0, minCooldown);
        await setRateLimitedUntil(env.DB, retryAfter, '/posts');
      }
      console.error('post_phase: failed', error);
      // Continue to summary - don't crash cron
    }
    } // Close rate-limit else block
  } else if (!canComment) {
    console.log('post_phase: skip, reason=budget_exhausted');
  }

    // Per-phase token telemetry
    try {
      const cycleStartIso = new Date(startTime).toISOString();
      const phaseTokens = await getCycleTokenBreakdown(env.DB, cycleStartIso);
      const totalCycleTokens = Object.values(phaseTokens).reduce((a, b) => a + b, 0);
      if (totalCycleTokens > 0) {
        const parts = Object.entries(phaseTokens)
          .sort(([,a], [,b]) => b - a)
          .map(([layer, tokens]) => `${layer}=${tokens}`);
        console.log(`phase_cost: total=${totalCycleTokens}, ${parts.join(', ')}`);
      }
    } catch (err) {
      console.error('phase_cost: query_failed', err);
    }

    const duration = Date.now() - startTime;
    console.log(`cron_complete: duration_ms=${duration}, subrequests=${getSubrequestCount()}/1000${tokenMode !== 'full' ? `, token_mode=${tokenMode}` : ''}`);
  } catch (error) {
    console.error('cron_fatal:', error);
    throw error;
  }
}
