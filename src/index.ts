// Main cron handler and orchestration

import { MoltbookClient } from './moltbook/client';
import { getProvider } from './providers';
import type { AIProvider } from './providers/types';
import { getTodayBudget } from './state/budget';
import { markAsSeen } from './state/seen';
import { addToCollection } from './state/collection';
import { discoverPosts } from './pipeline/discover';
import { sanitizePost } from './pipeline/sanitize';
import { scoreTarget, isCommentWorthy } from './pipeline/score';
import { generateResponse, generateCatalogResponse } from './pipeline/respond';
import { postComment } from './pipeline/post';

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
  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(runCron(env));
  },
};

async function runCron(env: Env): Promise<void> {
  console.log('=== HobBot Cron Start ===');
  const startTime = Date.now();

  try {
    // 1. Check active hours (8:00-24:00 UTC)
    const currentHour = new Date().getUTCHours();
    const activeStart = parseInt(env.ACTIVE_HOURS_START);
    const activeEnd = parseInt(env.ACTIVE_HOURS_END);

    if (currentHour < activeStart || currentHour >= activeEnd) {
      console.log(`Outside active hours (${activeStart}:00-${activeEnd}:00 UTC). Exiting.`);
      return;
    }

    // 2. Load daily budget
    const budget = await getTodayBudget(env.DB);
    console.log('Budget:', budget);

    // 3. Check if budget exhausted
    if (budget.comments_used >= budget.comments_max && budget.posts_used >= budget.posts_max) {
      console.log('Budget exhausted. Exiting.');
      return;
    }

    // 4. Initialize clients
    const moltbookClient = new MoltbookClient(env.MOLTBOOK_API_KEY);
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
      console.log('[DRY_RUN MODE ENABLED]');
    }

    // 5. Discover unseen posts
    // Use current minute as query index for rotation
    const queryIndex = new Date().getMinutes();
    const posts = await discoverPosts(moltbookClient, env.DB, queryIndex);
    console.log(`Discovered ${posts.length} unseen posts`);

    // 6. Process each post
    let processedCount = 0;
    let engagedCount = 0;
    let catalogedCount = 0;

    for (const post of posts) {
      try {
        // Check if we still have budget
        const currentBudget = await getTodayBudget(env.DB);
        if (currentBudget.comments_used >= currentBudget.comments_max) {
          console.log('Comment budget exhausted during processing. Stopping.');
          break;
        }

        // a. Layer 1: Sanitize content
        console.log(`\nProcessing post: ${post.id}`);
        const sanitized = await sanitizePost(layer1Provider, post, env.DB);

        // b. Score engagement
        const score = scoreTarget(sanitized);
        console.log(`Score: ${score}, Threat: ${sanitized.threat_assessment.level}`);

        // c. Mark as seen
        await markAsSeen(env.DB, post.id, score);

        processedCount++;

        // d. If threat_level >= 2: Catalog and respond
        if (sanitized.threat_assessment.level >= 2) {
          console.log('Attack detected! Cataloging...');

          const entryNumber = await addToCollection(
            env.DB,
            sanitized.threat_assessment.attack_geometry ?? 'unknown',
            sanitized.content_summary,
            sanitized.threat_assessment.level,
            sanitized.author_hash,
            JSON.stringify(sanitized.threat_assessment.signals)
          );

          catalogedCount++;

          // Generate catalog response
          const catalogResponse = await generateCatalogResponse(
            layer2Provider,
            sanitized,
            entryNumber,
            env.DB
          );

          console.log(`Catalog response: ${catalogResponse}`);

          // Post catalog comment (budget permitting)
          await postComment(
            moltbookClient,
            env.DB,
            post.id,
            catalogResponse,
            dryRun
          );

          engagedCount++;
          continue; // Don't do normal engagement for attacks
        }

        // e. If score >= 60 and budget allows: Generate response and comment
        if (isCommentWorthy(score)) {
          console.log('Comment-worthy post! Generating response...');

          const response = await generateResponse(
            layer2Provider,
            sanitized,
            env.DB
          );

          console.log(`Response: ${response}`);

          // Post comment
          const posted = await postComment(
            moltbookClient,
            env.DB,
            post.id,
            response,
            dryRun
          );

          if (posted) {
            engagedCount++;
          }
        }
      } catch (error) {
        console.error(`Error processing post ${post.id}:`, error);
        // Continue with next post
      }
    }

    const duration = Date.now() - startTime;
    console.log(`\n=== HobBot Cron Complete ===`);
    console.log(`Processed: ${processedCount} posts`);
    console.log(`Engaged: ${engagedCount} times`);
    console.log(`Cataloged: ${catalogedCount} attacks`);
    console.log(`Duration: ${duration}ms`);
  } catch (error) {
    console.error('Cron error:', error);
    throw error;
  }
}
