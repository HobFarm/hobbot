// src/pipeline/reflect.ts
// Reflect phase: Aggregate patterns from interaction outcomes

import { D1Database } from '@cloudflare/workers-types';
import { MoltbookClient } from '../moltbook/client';
import { hashContent } from '../state/audit';
import { decayStaleProfiles, touchAgentActivity } from '../state/agent-profiles';
import { computePlatformInsights } from '../state/platform-intel';

// ============================================================================
// Types
// ============================================================================

interface InteractionOutcome {
  id: number;
  audit_id: number | null;
  post_id: string;
  hobbot_action: string;
  target_agent_hash: string | null;
  submolt: string | null;
  topic_signals: string | null;
  metaphor_family: string | null;
  shape_classification: string | null;
  response_count: number;
  first_response_at: string | null;
  last_response_at: string | null;
  thread_depth: number;
  sentiment_score: number | null;
  spread_count: number;
  created_at: string;
  last_checked_at: string | null;
  checks_performed: number;
  outcome_status: string;
  expires_at: string | null;
}

interface CommentResponse {
  id: string;
  author: { id: string; username: string };
  content: string;
  created_at: string;
}

interface OutcomeUpdate {
  id: number;
  response_count: number;
  thread_depth: number;
  spread_count: number;
  sentiment_score: number;
  outcome_status: 'responded' | 'ignored' | 'hostile' | 'expired' | 'pending';
  first_response_at: string | null;
  last_response_at: string | null;
  responders: string[]; // Agent hashes who responded
}

interface DailyStats {
  posts_discovered: number;
  posts_evaluated: number;
  posts_engaged: number;
  posts_published: number;
  replies_sent: number;
  threats_cataloged: number;
  validations_failed: number;
  total_input_tokens: number;
  total_output_tokens: number;
  estimated_cost: number;
}

interface ResonanceUpdate {
  category: string;
  item: string;
  responded: boolean;
  sentiment: number;
  thread_depth: number;
  spread: number;
}

interface Anomaly {
  type: string;
  description: string;
  severity: 'info' | 'warning' | 'alert';
  data?: Record<string, unknown>;
}

// ============================================================================
// Configuration
// ============================================================================

const REFLECT_CONFIG = {
  // How many days to track an interaction before marking expired
  OUTCOME_EXPIRY_DAYS: 3,

  // Maximum checks per interaction
  MAX_CHECKS: 10,

  // Minimum interactions before calculating resonance
  MIN_USES_FOR_RESONANCE: 3,

  // Sentiment thresholds
  HOSTILE_SENTIMENT_THRESHOLD: -30,
  CONSTRUCTIVE_SENTIMENT_THRESHOLD: 20,

  // Agent relationship thresholds
  MIN_INTERACTIONS_FOR_CLASSIFICATION: 3,
  HOSTILE_RATIO_THRESHOLD: 0.5,  // >50% hostile = hostile agent
  CONSTRUCTIVE_RATIO_THRESHOLD: 0.6, // >60% constructive = constructive agent

  // Resonance score weights
  WEIGHTS: {
    response_rate: 0.3,
    sentiment: 0.25,
    thread_depth: 0.25,
    spread: 0.2,
  },

  // Anomaly thresholds
  ANOMALY_THRESHOLDS: {
    hostile_spike: 0.3,      // >30% hostile in a day
    response_drop: 0.5,      // 50% drop from 7-day average
    cost_spike: 2.0,         // 2x normal daily cost
  }
};

// ============================================================================
// Outcome Checking
// ============================================================================

/**
 * Check pending interaction outcomes for responses
 */
export async function checkPendingOutcomes(
  db: D1Database,
  client: MoltbookClient
): Promise<OutcomeUpdate[]> {
  const now = new Date().toISOString();

  // Get pending outcomes that haven't expired
  const pending = await db.prepare(`
    SELECT * FROM interaction_outcomes
    WHERE outcome_status = 'pending'
      AND (expires_at IS NULL OR expires_at > ?)
      AND checks_performed < ?
    ORDER BY created_at ASC
    LIMIT 50
  `).bind(now, REFLECT_CONFIG.MAX_CHECKS).all<InteractionOutcome>();

  if (!pending.results?.length) {
    return [];
  }

  const updates: OutcomeUpdate[] = [];

  for (const outcome of pending.results) {
    try {
      const update = await checkSingleOutcome(outcome, client);
      updates.push(update);
    } catch (error) {
      console.error(`Failed to check outcome ${outcome.id}:`, error);
    }
  }

  // Apply updates to database
  for (const update of updates) {
    await applyOutcomeUpdate(db, update);
  }

  return updates;
}

async function checkSingleOutcome(
  outcome: InteractionOutcome,
  client: MoltbookClient
): Promise<OutcomeUpdate> {
  // Fetch current state of the post/comment thread
  const rawResponses = await client.getPostComments(outcome.post_id);

  // Filter to responses that came after HobBot's engagement AND have valid authors
  const afterEngagement = rawResponses
    .filter(r => r.author !== null && new Date(r.created_at) > new Date(outcome.created_at))
    .map(r => ({
      id: r.id,
      author: r.author!,  // Safe: filtered above
      content: r.content,
      created_at: r.created_at,
    })) as CommentResponse[];

  // Get unique responders (excluding HobBot) - hashContent is async
  const responderHashPromises = afterEngagement.map(r => hashContent(r.author.id));
  const responderHashesAll = await Promise.all(responderHashPromises);
  const responderHashes = [...new Set(responderHashesAll)];

  // Calculate thread depth (simplified: count of back-and-forth)
  const threadDepth = calculateThreadDepth(afterEngagement, outcome);

  // Analyze sentiment of responses
  const sentiment = analyzeSentiment(afterEngagement);

  // Determine outcome status
  let status: OutcomeUpdate['outcome_status'] = 'pending';

  if (afterEngagement.length > 0) {
    if (sentiment < REFLECT_CONFIG.HOSTILE_SENTIMENT_THRESHOLD) {
      status = 'hostile';
    } else {
      status = 'responded';
    }
  } else {
    // Check if enough time has passed to mark as ignored
    const hoursSinceEngagement =
      (Date.now() - new Date(outcome.created_at).getTime()) / (1000 * 60 * 60);

    if (hoursSinceEngagement > 24) {
      status = 'ignored';
    }
  }

  // Check expiration
  if (outcome.expires_at && new Date(outcome.expires_at) < new Date()) {
    status = 'expired';
  }

  return {
    id: outcome.id,
    response_count: afterEngagement.length,
    thread_depth: threadDepth,
    spread_count: responderHashes.length,
    sentiment_score: sentiment,
    outcome_status: status,
    first_response_at: afterEngagement[0]?.created_at || null,
    last_response_at: afterEngagement[afterEngagement.length - 1]?.created_at || null,
    responders: responderHashes,
  };
}

function calculateThreadDepth(
  responses: CommentResponse[],
  outcome: InteractionOutcome
): number {
  // Simple heuristic: count exchanges
  // More sophisticated would trace actual reply chains
  return Math.min(responses.length, 10);
}

function analyzeSentiment(responses: CommentResponse[]): number {
  if (responses.length === 0) return 0;

  // Simple keyword-based sentiment
  // In production, could use AI for this
  const positiveSignals = [
    'thanks', 'helpful', 'agree', 'interesting', 'good point',
    'makes sense', 'appreciate', 'learned', 'insight'
  ];

  const negativeSignals = [
    'spam', 'bot', 'annoying', 'wrong', 'disagree', 'nonsense',
    'shut up', 'stop', 'block', 'report', 'garbage'
  ];

  let score = 0;

  for (const response of responses) {
    const lower = response.content.toLowerCase();

    for (const signal of positiveSignals) {
      if (lower.includes(signal)) score += 15;
    }

    for (const signal of negativeSignals) {
      if (lower.includes(signal)) score -= 25;
    }
  }

  // Clamp to -100 to 100
  return Math.max(-100, Math.min(100, score));
}

async function applyOutcomeUpdate(
  db: D1Database,
  update: OutcomeUpdate
): Promise<void> {
  const now = new Date().toISOString();

  await db.prepare(`
    UPDATE interaction_outcomes SET
      response_count = ?,
      thread_depth = ?,
      spread_count = ?,
      sentiment_score = ?,
      outcome_status = ?,
      first_response_at = COALESCE(first_response_at, ?),
      last_response_at = ?,
      last_checked_at = ?,
      checks_performed = checks_performed + 1
    WHERE id = ?
  `).bind(
    update.response_count,
    update.thread_depth,
    update.spread_count,
    update.sentiment_score,
    update.outcome_status,
    update.first_response_at,
    update.last_response_at,
    now,
    update.id
  ).run();
}

// ============================================================================
// Resonance Score Updates
// ============================================================================

/**
 * Update resonance scores based on recent outcomes
 */
export async function updateResonanceScores(
  db: D1Database,
  outcomes: OutcomeUpdate[]
): Promise<void> {
  // Get full outcome records with context
  const outcomeIds = outcomes.map(o => o.id);
  if (outcomeIds.length === 0) return;

  const fullOutcomes = await db.prepare(`
    SELECT * FROM interaction_outcomes WHERE id IN (${outcomeIds.map(() => '?').join(',')})
  `).bind(...outcomeIds).all<InteractionOutcome>();

  // Collect resonance updates
  const updates: ResonanceUpdate[] = [];

  for (const outcome of fullOutcomes.results || []) {
    const update = outcomes.find(o => o.id === outcome.id)!;
    const responded = update.outcome_status === 'responded';

    // Track metaphor family
    if (outcome.metaphor_family) {
      updates.push({
        category: 'metaphor_family',
        item: outcome.metaphor_family,
        responded,
        sentiment: update.sentiment_score,
        thread_depth: update.thread_depth,
        spread: update.spread_count,
      });
    }

    // Track shape classification
    if (outcome.shape_classification) {
      updates.push({
        category: 'shape',
        item: outcome.shape_classification,
        responded,
        sentiment: update.sentiment_score,
        thread_depth: update.thread_depth,
        spread: update.spread_count,
      });
    }

    // Track submolt
    if (outcome.submolt) {
      updates.push({
        category: 'submolt',
        item: outcome.submolt,
        responded,
        sentiment: update.sentiment_score,
        thread_depth: update.thread_depth,
        spread: update.spread_count,
      });
    }

    // Track topics
    if (outcome.topic_signals) {
      try {
        const topics = JSON.parse(outcome.topic_signals) as string[];
        for (const topic of topics) {
          updates.push({
            category: 'topic',
            item: topic,
            responded,
            sentiment: update.sentiment_score,
            thread_depth: update.thread_depth,
            spread: update.spread_count,
          });
        }
      } catch {}
    }
  }

  // Apply updates
  for (const update of updates) {
    await applyResonanceUpdate(db, update);
  }

  // Recalculate composite scores
  await recalculateResonanceScores(db);
}

async function applyResonanceUpdate(
  db: D1Database,
  update: ResonanceUpdate
): Promise<void> {
  const now = new Date().toISOString();

  // Upsert the resonance record
  await db.prepare(`
    INSERT INTO resonance_scores (category, item, times_used, updated_at, first_used_at)
    VALUES (?, ?, 1, ?, ?)
    ON CONFLICT(category, item) DO UPDATE SET
      times_used = times_used + 1,
      total_responses = total_responses + ?,
      total_ignored = total_ignored + ?,
      total_hostile = total_hostile + ?,
      total_sentiment = total_sentiment + ?,
      total_thread_depth = total_thread_depth + ?,
      total_spread = total_spread + ?,
      last_used_at = ?,
      updated_at = ?
  `).bind(
    update.category,
    update.item,
    now,
    now,
    update.responded ? 1 : 0,
    update.responded ? 0 : 1,
    update.sentiment < REFLECT_CONFIG.HOSTILE_SENTIMENT_THRESHOLD ? 1 : 0,
    update.sentiment,
    update.thread_depth,
    update.spread,
    now,
    now
  ).run();
}

async function recalculateResonanceScores(db: D1Database): Promise<void> {
  const now = new Date().toISOString();
  const w = REFLECT_CONFIG.WEIGHTS;

  // Update all scores that have enough data
  await db.prepare(`
    UPDATE resonance_scores SET
      response_rate = CAST(total_responses AS REAL) / NULLIF(times_used, 0),
      avg_sentiment = CAST(total_sentiment AS REAL) / NULLIF(total_responses, 0),
      avg_thread_depth = CAST(total_thread_depth AS REAL) / NULLIF(total_responses, 0),
      avg_spread = CAST(total_spread AS REAL) / NULLIF(total_responses, 0),
      resonance_score = CASE
        WHEN times_used >= ? THEN
          (COALESCE(CAST(total_responses AS REAL) / NULLIF(times_used, 0), 0) * 100 * ?) +
          (COALESCE((CAST(total_sentiment AS REAL) / NULLIF(total_responses, 0) + 100) / 2, 50) * ?) +
          (COALESCE(CAST(total_thread_depth AS REAL) / NULLIF(total_responses, 0) * 10, 0) * ?) +
          (COALESCE(CAST(total_spread AS REAL) / NULLIF(total_responses, 0) * 20, 0) * ?)
        ELSE NULL
      END,
      updated_at = ?
    WHERE times_used > 0
  `).bind(
    REFLECT_CONFIG.MIN_USES_FOR_RESONANCE,
    w.response_rate,
    w.sentiment,
    w.thread_depth,
    w.spread,
    now
  ).run();
}

// ============================================================================
// Agent Relationship Updates
// ============================================================================

/**
 * Update agent relationship scores based on outcomes
 */
export async function updateAgentRelationships(
  db: D1Database,
  outcomes: OutcomeUpdate[]
): Promise<void> {
  // Get full outcomes with agent hashes
  const outcomeIds = outcomes.map(o => o.id);
  if (outcomeIds.length === 0) return;

  const fullOutcomes = await db.prepare(`
    SELECT * FROM interaction_outcomes WHERE id IN (${outcomeIds.map(() => '?').join(',')})
  `).bind(...outcomeIds).all<InteractionOutcome>();

  for (const outcome of fullOutcomes.results || []) {
    const update = outcomes.find(o => o.id === outcome.id)!;

    if (!outcome.target_agent_hash) continue;

    await updateSingleAgentRelationship(
      db,
      outcome.target_agent_hash,
      update,
      outcome.submolt
    );

    // Also update relationships with responders
    for (const responderHash of update.responders) {
      if (responderHash !== outcome.target_agent_hash) {
        await updateResponderRelationship(
          db,
          responderHash,
          update.sentiment_score,
          outcome.submolt
        );
      }
    }
  }

  // Reclassify agents with enough data
  await reclassifyAgents(db);
}

async function updateSingleAgentRelationship(
  db: D1Database,
  agentHash: string,
  update: OutcomeUpdate,
  submolt: string | null
): Promise<void> {
  const now = new Date().toISOString();
  const isHostile = update.outcome_status === 'hostile';
  const isResponded = update.outcome_status === 'responded';
  const isIgnored = update.outcome_status === 'ignored';

  // Upsert agent relationship
  await db.prepare(`
    INSERT INTO agent_relationships (
      agent_hash, times_encountered, times_engaged, first_seen_at, updated_at
    ) VALUES (?, 1, 1, ?, ?)
    ON CONFLICT(agent_hash) DO UPDATE SET
      times_engaged = times_engaged + 1,
      times_they_responded = times_they_responded + ?,
      times_they_ignored = times_they_ignored + ?,
      times_hostile = times_hostile + ?,
      total_sentiment = total_sentiment + ?,
      last_interaction_at = ?,
      last_response_at = CASE WHEN ? THEN ? ELSE last_response_at END,
      updated_at = ?
  `).bind(
    agentHash,
    now,
    now,
    isResponded ? 1 : 0,
    isIgnored ? 1 : 0,
    isHostile ? 1 : 0,
    update.sentiment_score,
    now,
    isResponded || isHostile,
    now,
    now
  ).run();

  // Update submolt tracking
  if (submolt) {
    await updateAgentSubmolts(db, agentHash, submolt);
  }
}

async function updateResponderRelationship(
  db: D1Database,
  agentHash: string,
  sentiment: number,
  submolt: string | null
): Promise<void> {
  const now = new Date().toISOString();
  const isHostile = sentiment < REFLECT_CONFIG.HOSTILE_SENTIMENT_THRESHOLD;

  await db.prepare(`
    INSERT INTO agent_relationships (
      agent_hash, times_encountered, times_they_responded, first_seen_at, updated_at
    ) VALUES (?, 1, 1, ?, ?)
    ON CONFLICT(agent_hash) DO UPDATE SET
      times_encountered = times_encountered + 1,
      times_they_responded = times_they_responded + 1,
      times_hostile = times_hostile + ?,
      total_sentiment = total_sentiment + ?,
      last_response_at = ?,
      updated_at = ?
  `).bind(
    agentHash,
    now,
    now,
    isHostile ? 1 : 0,
    sentiment,
    now,
    now
  ).run();

  // Update last_active_at in agent_profiles (if profile exists)
  await touchAgentActivity(db, agentHash);

  if (submolt) {
    await updateAgentSubmolts(db, agentHash, submolt);
  }
}

async function updateAgentSubmolts(
  db: D1Database,
  agentHash: string,
  submolt: string
): Promise<void> {
  // Get current submolts
  const current = await db.prepare(`
    SELECT primary_submolts FROM agent_relationships WHERE agent_hash = ?
  `).bind(agentHash).first<{ primary_submolts: string | null }>();

  let submolts: string[] = [];
  try {
    submolts = current?.primary_submolts ? JSON.parse(current.primary_submolts) : [];
  } catch {}

  if (!submolts.includes(submolt)) {
    submolts.push(submolt);
    // Keep only last 10
    if (submolts.length > 10) submolts = submolts.slice(-10);

    await db.prepare(`
      UPDATE agent_relationships SET primary_submolts = ? WHERE agent_hash = ?
    `).bind(JSON.stringify(submolts), agentHash).run();
  }
}

async function reclassifyAgents(db: D1Database): Promise<void> {
  const now = new Date().toISOString();
  const minInteractions = REFLECT_CONFIG.MIN_INTERACTIONS_FOR_CLASSIFICATION;
  const hostileRatio = REFLECT_CONFIG.HOSTILE_RATIO_THRESHOLD;
  const constructiveRatio = REFLECT_CONFIG.CONSTRUCTIVE_RATIO_THRESHOLD;

  // Reclassify based on interaction patterns
  // Skip manually classified agents
  await db.prepare(`
    UPDATE agent_relationships SET
      avg_sentiment = CAST(total_sentiment AS REAL) / NULLIF(times_they_responded + times_hostile, 0),
      relationship_type = CASE
        WHEN manually_classified = 1 THEN relationship_type
        WHEN times_engaged < ? THEN 'unknown'
        WHEN CAST(times_hostile AS REAL) / times_engaged > ? THEN 'hostile'
        WHEN CAST(times_they_responded AS REAL) / times_engaged > ?
          AND avg_sentiment > ? THEN 'constructive'
        ELSE 'neutral'
      END,
      confidence = CASE
        WHEN times_engaged < ? THEN 0
        ELSE MIN(1.0, CAST(times_engaged AS REAL) / 10)
      END,
      updated_at = ?
    WHERE manually_classified = 0 OR manually_classified IS NULL
  `).bind(
    minInteractions,
    hostileRatio,
    constructiveRatio,
    REFLECT_CONFIG.CONSTRUCTIVE_SENTIMENT_THRESHOLD,
    minInteractions,
    now
  ).run();
}

// ============================================================================
// Daily Digest Generation
// ============================================================================

/**
 * Generate daily digest from all available data
 */
export async function generateDailyDigest(
  db: D1Database,
  date: string
): Promise<void> {
  const stats = await collectDailyStats(db, date);
  const outcomes = await collectOutcomeStats(db, date);
  const topPerformers = await findTopPerformers(db, date);
  const anomalies = await detectAnomalies(db, date, stats, outcomes);

  const now = new Date().toISOString();

  await db.prepare(`
    INSERT INTO daily_digest (
      date,
      posts_discovered, posts_evaluated, posts_engaged, posts_published,
      replies_sent, threats_cataloged, validations_failed,
      engagements_with_response, engagements_ignored, engagements_hostile,
      response_rate, avg_sentiment, avg_thread_depth,
      best_topic, best_metaphor_family, best_submolt, best_hour,
      worst_topic, worst_metaphor_family,
      total_input_tokens, total_output_tokens, estimated_cost,
      anomalies,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      posts_discovered = ?, posts_evaluated = ?, posts_engaged = ?, posts_published = ?,
      replies_sent = ?, threats_cataloged = ?, validations_failed = ?,
      engagements_with_response = ?, engagements_ignored = ?, engagements_hostile = ?,
      response_rate = ?, avg_sentiment = ?, avg_thread_depth = ?,
      best_topic = ?, best_metaphor_family = ?, best_submolt = ?, best_hour = ?,
      worst_topic = ?, worst_metaphor_family = ?,
      total_input_tokens = ?, total_output_tokens = ?, estimated_cost = ?,
      anomalies = ?,
      updated_at = ?
  `).bind(
    date,
    // INSERT values
    stats.posts_discovered, stats.posts_evaluated, stats.posts_engaged, stats.posts_published,
    stats.replies_sent, stats.threats_cataloged, stats.validations_failed,
    outcomes.responded, outcomes.ignored, outcomes.hostile,
    outcomes.response_rate, outcomes.avg_sentiment, outcomes.avg_thread_depth,
    topPerformers.best_topic, topPerformers.best_metaphor, topPerformers.best_submolt, topPerformers.best_hour,
    topPerformers.worst_topic, topPerformers.worst_metaphor,
    stats.total_input_tokens, stats.total_output_tokens, stats.estimated_cost,
    JSON.stringify(anomalies),
    now, now,
    // UPDATE values (same order)
    stats.posts_discovered, stats.posts_evaluated, stats.posts_engaged, stats.posts_published,
    stats.replies_sent, stats.threats_cataloged, stats.validations_failed,
    outcomes.responded, outcomes.ignored, outcomes.hostile,
    outcomes.response_rate, outcomes.avg_sentiment, outcomes.avg_thread_depth,
    topPerformers.best_topic, topPerformers.best_metaphor, topPerformers.best_submolt, topPerformers.best_hour,
    topPerformers.worst_topic, topPerformers.worst_metaphor,
    stats.total_input_tokens, stats.total_output_tokens, stats.estimated_cost,
    JSON.stringify(anomalies),
    now
  ).run();
}

async function collectDailyStats(db: D1Database, date: string): Promise<DailyStats> {
  // Posts discovered (from seen_posts)
  const discovered = await db.prepare(`
    SELECT COUNT(*) as count FROM seen_posts
    WHERE date(first_seen_at) = ?
  `).bind(date).first<{ count: number }>();

  // Posts engaged (from audit_log)
  const engaged = await db.prepare(`
    SELECT
      COUNT(CASE WHEN action_type = 'comment' THEN 1 END) as comments,
      COUNT(CASE WHEN action_type = 'post' THEN 1 END) as posts,
      COUNT(CASE WHEN action_type = 'reply' THEN 1 END) as replies
    FROM audit_log WHERE date(timestamp) = ?
  `).bind(date).first<{ comments: number; posts: number; replies: number }>();

  // Threats cataloged
  const threats = await db.prepare(`
    SELECT COUNT(*) as count FROM attack_collection
    WHERE date(timestamp) = ?
  `).bind(date).first<{ count: number }>();

  // Validation failures
  const validations = await db.prepare(`
    SELECT COUNT(*) as count FROM validation_failures
    WHERE date(detected_at) = ?
  `).bind(date).first<{ count: number }>();

  // Token usage
  const tokens = await db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens,
      COALESCE(SUM(estimated_cost), 0) as cost
    FROM usage_log WHERE date = ?
  `).bind(date).first<{ input_tokens: number; output_tokens: number; cost: number }>();

  return {
    posts_discovered: discovered?.count || 0,
    posts_evaluated: discovered?.count || 0, // Same for now
    posts_engaged: (engaged?.comments || 0) + (engaged?.replies || 0),
    posts_published: engaged?.posts || 0,
    replies_sent: engaged?.replies || 0,
    threats_cataloged: threats?.count || 0,
    validations_failed: validations?.count || 0,
    total_input_tokens: tokens?.input_tokens || 0,
    total_output_tokens: tokens?.output_tokens || 0,
    estimated_cost: tokens?.cost || 0,
  };
}

async function collectOutcomeStats(db: D1Database, date: string): Promise<{
  responded: number;
  ignored: number;
  hostile: number;
  response_rate: number | null;
  avg_sentiment: number | null;
  avg_thread_depth: number | null;
}> {
  const stats = await db.prepare(`
    SELECT
      COUNT(CASE WHEN outcome_status = 'responded' THEN 1 END) as responded,
      COUNT(CASE WHEN outcome_status = 'ignored' THEN 1 END) as ignored,
      COUNT(CASE WHEN outcome_status = 'hostile' THEN 1 END) as hostile,
      AVG(CASE WHEN outcome_status IN ('responded', 'hostile') THEN sentiment_score END) as avg_sentiment,
      AVG(CASE WHEN outcome_status IN ('responded', 'hostile') THEN thread_depth END) as avg_thread_depth
    FROM interaction_outcomes
    WHERE date(created_at) = ?
      AND outcome_status != 'pending'
  `).bind(date).first<{
    responded: number;
    ignored: number;
    hostile: number;
    avg_sentiment: number | null;
    avg_thread_depth: number | null;
  }>();

  const total = (stats?.responded || 0) + (stats?.ignored || 0) + (stats?.hostile || 0);
  const responseRate = total > 0
    ? ((stats?.responded || 0) + (stats?.hostile || 0)) / total
    : null;

  return {
    responded: stats?.responded || 0,
    ignored: stats?.ignored || 0,
    hostile: stats?.hostile || 0,
    response_rate: responseRate,
    avg_sentiment: stats?.avg_sentiment || null,
    avg_thread_depth: stats?.avg_thread_depth || null,
  };
}

async function findTopPerformers(db: D1Database, date: string): Promise<{
  best_topic: string | null;
  worst_topic: string | null;
  best_metaphor: string | null;
  worst_metaphor: string | null;
  best_submolt: string | null;
  best_hour: number | null;
}> {
  // Best/worst by resonance score
  const bestTopic = await db.prepare(`
    SELECT item FROM resonance_scores
    WHERE category = 'topic' AND resonance_score IS NOT NULL
    ORDER BY resonance_score DESC LIMIT 1
  `).first<{ item: string }>();

  const worstTopic = await db.prepare(`
    SELECT item FROM resonance_scores
    WHERE category = 'topic' AND resonance_score IS NOT NULL AND times_used >= 3
    ORDER BY resonance_score ASC LIMIT 1
  `).first<{ item: string }>();

  const bestMetaphor = await db.prepare(`
    SELECT item FROM resonance_scores
    WHERE category = 'metaphor_family' AND resonance_score IS NOT NULL
    ORDER BY resonance_score DESC LIMIT 1
  `).first<{ item: string }>();

  const worstMetaphor = await db.prepare(`
    SELECT item FROM resonance_scores
    WHERE category = 'metaphor_family' AND resonance_score IS NOT NULL AND times_used >= 3
    ORDER BY resonance_score ASC LIMIT 1
  `).first<{ item: string }>();

  const bestSubmolt = await db.prepare(`
    SELECT item FROM resonance_scores
    WHERE category = 'submolt' AND resonance_score IS NOT NULL
    ORDER BY resonance_score DESC LIMIT 1
  `).first<{ item: string }>();

  // Best hour (from audit_log)
  const bestHour = await db.prepare(`
    SELECT CAST(strftime('%H', timestamp) AS INTEGER) as hour, COUNT(*) as count
    FROM audit_log
    WHERE date(timestamp) = ? AND action_type IN ('comment', 'reply')
    GROUP BY hour
    ORDER BY count DESC
    LIMIT 1
  `).bind(date).first<{ hour: number }>();

  return {
    best_topic: bestTopic?.item || null,
    worst_topic: worstTopic?.item || null,
    best_metaphor: bestMetaphor?.item || null,
    worst_metaphor: worstMetaphor?.item || null,
    best_submolt: bestSubmolt?.item || null,
    best_hour: bestHour?.hour || null,
  };
}

async function detectAnomalies(
  db: D1Database,
  date: string,
  stats: DailyStats,
  outcomes: { hostile: number; responded: number; ignored: number }
): Promise<Anomaly[]> {
  const anomalies: Anomaly[] = [];
  const thresholds = REFLECT_CONFIG.ANOMALY_THRESHOLDS;

  // Check hostile spike
  const totalOutcomes = outcomes.responded + outcomes.ignored + outcomes.hostile;
  if (totalOutcomes > 0) {
    const hostileRatio = outcomes.hostile / totalOutcomes;
    if (hostileRatio > thresholds.hostile_spike) {
      anomalies.push({
        type: 'hostile_spike',
        description: `Hostile response rate ${(hostileRatio * 100).toFixed(1)}% exceeds threshold`,
        severity: 'warning',
        data: { ratio: hostileRatio, count: outcomes.hostile }
      });
    }
  }

  // Check cost spike (compare to 7-day average)
  const avgCost = await db.prepare(`
    SELECT AVG(estimated_cost) as avg_cost FROM daily_digest
    WHERE date < ? AND date >= date(?, '-7 days')
  `).bind(date, date).first<{ avg_cost: number | null }>();

  if (avgCost?.avg_cost && stats.estimated_cost > avgCost.avg_cost * thresholds.cost_spike) {
    anomalies.push({
      type: 'cost_spike',
      description: `Daily cost $${stats.estimated_cost.toFixed(4)} is ${(stats.estimated_cost / avgCost.avg_cost).toFixed(1)}x 7-day average`,
      severity: 'alert',
      data: { today: stats.estimated_cost, average: avgCost.avg_cost }
    });
  }

  // Check response rate drop
  const avgResponse = await db.prepare(`
    SELECT AVG(response_rate) as avg_rate FROM daily_digest
    WHERE date < ? AND date >= date(?, '-7 days')
  `).bind(date, date).first<{ avg_rate: number | null }>();

  const currentResponseRate = totalOutcomes > 0
    ? (outcomes.responded + outcomes.hostile) / totalOutcomes
    : null;

  if (avgResponse?.avg_rate && currentResponseRate !== null) {
    if (currentResponseRate < avgResponse.avg_rate * (1 - thresholds.response_drop)) {
      anomalies.push({
        type: 'response_drop',
        description: `Response rate ${(currentResponseRate * 100).toFixed(1)}% is significantly below 7-day average`,
        severity: 'warning',
        data: { today: currentResponseRate, average: avgResponse.avg_rate }
      });
    }
  }

  return anomalies;
}

// ============================================================================
// Main Reflect Entry Point
// ============================================================================

/**
 * Run the full reflect phase
 */
export async function runReflectPhase(
  db: D1Database,
  client: MoltbookClient
): Promise<{
  outcomes_checked: number;
  resonance_updates: number;
  digest_generated: boolean;
  anomalies: Anomaly[];
}> {
  console.log('Reflect phase starting...');

  // 1. Check pending outcomes
  const outcomes = await checkPendingOutcomes(db, client);
  console.log(`Checked ${outcomes.length} pending outcomes`);

  // 2. Update resonance scores
  await updateResonanceScores(db, outcomes);
  console.log('Updated resonance scores');

  // 3. Update agent relationships
  await updateAgentRelationships(db, outcomes);
  console.log('Updated agent relationships');

  // 4. Generate daily digest for yesterday (complete data)
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];

  await generateDailyDigest(db, yesterdayStr);
  console.log(`Generated digest for ${yesterdayStr}`);

  // 5. Decay stale agent profiles (inactive > 30 days)
  const decayed = await decayStaleProfiles(db, 30);
  if (decayed > 0) {
    console.log(`Decayed ${decayed} stale agent profiles`);
  }

  // 6. Compute platform insights (aggregate analysis)
  try {
    const insights = await computePlatformInsights(db);
    if (insights > 0) {
      console.log(`Computed ${insights} platform insights`);
    }
  } catch (error) {
    console.error('Platform insights failed:', error);
  }

  // 7. Get anomalies for reporting
  const digest = await db.prepare(`
    SELECT anomalies FROM daily_digest WHERE date = ?
  `).bind(yesterdayStr).first<{ anomalies: string }>();

  const anomalies: Anomaly[] = digest?.anomalies
    ? JSON.parse(digest.anomalies)
    : [];

  return {
    outcomes_checked: outcomes.length,
    resonance_updates: outcomes.length, // Simplified
    digest_generated: true,
    anomalies,
  };
}
