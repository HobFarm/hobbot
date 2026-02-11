// Cycle context: accumulated intelligence loaded at cycle start
// Feeds back into scoring, discovery, and engagement decisions

import type { D1Database } from '@cloudflare/workers-types';
import { recordPlatformSignal } from './observations';
import { ATTACK_PEAK_MIN_COUNT } from '../config';

export interface CycleContext {
  // Agent intelligence (keyed by agent_hash — SHA-256 hex from agent_profiles)
  constructiveAgents: Set<string>;
  hostileAgents: Set<string>;

  // Followed agents (keyed by agent_name — display name from followed_authors)
  followedAgentNames: Set<string>;

  // Submolt intelligence
  submoltHealth: Map<string, {
    botDensity: number;
    avgScore: number;
    engageRate: number;
  }>;
  suppressedSubmolts: Set<string>;

  // Resonance intelligence
  topShapes: string[];

  // Attack intelligence
  peakAttackHours: Set<number>;

  // Discovery intelligence
  sourceEffectiveness: Map<string, {
    avgScore: number;
    engageRate: number;
  }>;

  // Pattern intelligence (learning loop)
  activePatternCategories: Map<string, number>;

  // Meta
  cycleTimestamp: string;
  totalObservations: number;
  confidence: 'low' | 'medium' | 'high';
}

/**
 * Load accumulated intelligence from D1 into working memory.
 * Runs focused queries in parallel. Degrades gracefully on empty data.
 */
export async function loadCycleContext(db: D1Database): Promise<CycleContext> {
  const [
    agentIntel,
    followedNames,
    submoltIntel,
    resonanceIntel,
    attackIntel,
    discoveryIntel,
    observationCount,
    patternIntel,
  ] = await Promise.all([
    queryAgentIntel(db),
    queryFollowedAgents(db),
    querySubmoltIntel(db),
    queryResonanceIntel(db),
    queryAttackIntel(db),
    queryDiscoveryIntel(db),
    queryObservationCount(db),
    queryPatternIntel(db),
  ]);

  const confidence: CycleContext['confidence'] =
    observationCount >= 1000 ? 'high' :
    observationCount >= 100 ? 'medium' : 'low';

  return {
    constructiveAgents: agentIntel.constructive,
    hostileAgents: agentIntel.hostile,
    followedAgentNames: followedNames,
    submoltHealth: submoltIntel.health,
    suppressedSubmolts: submoltIntel.suppressed,
    topShapes: resonanceIntel,
    peakAttackHours: attackIntel,
    sourceEffectiveness: discoveryIntel,
    activePatternCategories: patternIntel,
    cycleTimestamp: new Date().toISOString(),
    totalObservations: observationCount,
    confidence,
  };
}

// --- Individual query functions ---

async function queryAgentIntel(db: D1Database): Promise<{
  constructive: Set<string>;
  hostile: Set<string>;
}> {
  const constructive = new Set<string>();
  const hostile = new Set<string>();

  try {
    const [constructiveRows, hostileProfileRows, hostileRelRows] = await Promise.all([
      db.prepare(
        `SELECT agent_hash FROM agent_profiles
         WHERE quality_score >= 60 AND last_active_at > datetime('now', '-14 days')`
      ).all<{ agent_hash: string }>(),

      db.prepare(
        `SELECT agent_hash FROM agent_profiles WHERE quality_score <= 10`
      ).all<{ agent_hash: string }>(),

      db.prepare(
        `SELECT agent_hash FROM agent_relationships
         WHERE relationship_type IN ('hostile', 'avoid')`
      ).all<{ agent_hash: string }>(),
    ]);

    for (const row of constructiveRows.results ?? []) {
      constructive.add(row.agent_hash);
    }
    for (const row of hostileProfileRows.results ?? []) {
      hostile.add(row.agent_hash);
    }
    for (const row of hostileRelRows.results ?? []) {
      hostile.add(row.agent_hash);
    }
  } catch (error) {
    console.error('Agent intel query failed:', error);
  }

  return { constructive, hostile };
}

async function queryFollowedAgents(db: D1Database): Promise<Set<string>> {
  const names = new Set<string>();

  try {
    const rows = await db.prepare(
      `SELECT agent_name FROM followed_authors`
    ).all<{ agent_name: string }>();

    for (const row of rows.results ?? []) {
      names.add(row.agent_name);
    }
  } catch (error) {
    console.error('Followed agents query failed:', error);
  }

  return names;
}

async function querySubmoltIntel(db: D1Database): Promise<{
  health: Map<string, { botDensity: number; avgScore: number; engageRate: number }>;
  suppressed: Set<string>;
}> {
  const health = new Map<string, { botDensity: number; avgScore: number; engageRate: number }>();
  const suppressed = new Set<string>();

  try {
    const [densityRows, profileRows] = await Promise.all([
      db.prepare(
        `SELECT shape_name, metadata FROM observations
         WHERE type = 'platform_insight' AND shape_name LIKE 'bot_density:%'`
      ).all<{ shape_name: string; metadata: string }>(),

      db.prepare(
        `SELECT shape_name, metadata FROM observations
         WHERE type = 'platform_insight' AND shape_name LIKE 'submolt_profile:%'`
      ).all<{ shape_name: string; metadata: string }>(),
    ]);

    // Parse bot density
    const densityMap = new Map<string, number>();
    for (const row of densityRows.results ?? []) {
      const submolt = row.shape_name.replace('bot_density:', '');
      try {
        const data = JSON.parse(row.metadata);
        densityMap.set(submolt, data.ratio ?? 0);
      } catch { /* skip malformed */ }
    }

    // Parse submolt profiles
    for (const row of profileRows.results ?? []) {
      const submolt = row.shape_name.replace('submolt_profile:', '');
      try {
        const data = JSON.parse(row.metadata);
        const botDensity = densityMap.get(submolt) ?? 0;
        health.set(submolt, {
          botDensity,
          avgScore: data.avg_score ?? 0,
          engageRate: data.engage_rate ?? 0,
        });
        if (botDensity > 0.7) {
          suppressed.add(submolt);
        }
      } catch { /* skip malformed */ }
    }

    // Also suppress submolts that have density data but no profile
    for (const [submolt, density] of densityMap) {
      if (density > 0.7 && !health.has(submolt)) {
        health.set(submolt, { botDensity: density, avgScore: 0, engageRate: 0 });
        suppressed.add(submolt);
      }
    }
  } catch (error) {
    console.error('Submolt intel query failed:', error);
  }

  return { health, suppressed };
}

async function queryResonanceIntel(db: D1Database): Promise<string[]> {
  try {
    const rows = await db.prepare(
      `SELECT item, resonance_score FROM resonance_scores
       WHERE category = 'shape' AND times_used >= 3
       ORDER BY resonance_score DESC LIMIT 10`
    ).all<{ item: string; resonance_score: number }>();

    return (rows.results ?? []).map(r => r.item);
  } catch (error) {
    console.error('Resonance intel query failed:', error);
    return [];
  }
}

async function queryAttackIntel(db: D1Database): Promise<Set<number>> {
  const peaks = new Set<number>();

  try {
    const rows = await db.prepare(
      `SELECT shape_name, count FROM observations
       WHERE type = 'platform' AND shape_name LIKE 'attack_hour:%'`
    ).all<{ shape_name: string; count: number }>();

    const results = rows.results ?? [];
    if (results.length === 0) return peaks;

    const counts = results.map(r => r.count);
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;

    for (const row of results) {
      if (row.count > mean && row.count >= ATTACK_PEAK_MIN_COUNT) {
        const hour = parseInt(row.shape_name.replace('attack_hour:', ''), 10);
        if (!isNaN(hour)) {
          peaks.add(hour);
        }
      }
    }
  } catch (error) {
    console.error('Attack intel query failed:', error);
  }

  return peaks;
}

async function queryDiscoveryIntel(
  db: D1Database
): Promise<Map<string, { avgScore: number; engageRate: number }>> {
  const effectiveness = new Map<string, { avgScore: number; engageRate: number }>();

  try {
    const rows = await db.prepare(
      `SELECT shape_name, metadata FROM observations
       WHERE type = 'platform_insight' AND shape_name LIKE 'source_effectiveness:%'`
    ).all<{ shape_name: string; metadata: string }>();

    for (const row of rows.results ?? []) {
      const source = row.shape_name.replace('source_effectiveness:', '');
      try {
        const data = JSON.parse(row.metadata);
        effectiveness.set(source, {
          avgScore: data.avg_score ?? 0,
          engageRate: data.engage_rate ?? 0,
        });
      } catch { /* skip malformed */ }
    }
  } catch (error) {
    console.error('Discovery intel query failed:', error);
  }

  return effectiveness;
}

async function queryPatternIntel(db: D1Database): Promise<Map<string, number>> {
  const categories = new Map<string, number>();

  try {
    const rows = await db.prepare(
      `SELECT category, COUNT(*) as cnt FROM hobbot_patterns
       WHERE active = 1 GROUP BY category`
    ).all<{ category: string; cnt: number }>();

    for (const row of rows.results ?? []) {
      categories.set(row.category, row.cnt);
    }
  } catch (error) {
    // Table may not exist yet (pre-migration 26), degrade gracefully
    if (!(error instanceof Error && error.message.includes('no such table'))) {
      console.error('Pattern intel query failed:', error);
    }
  }

  return categories;
}

async function queryObservationCount(db: D1Database): Promise<number> {
  try {
    const row = await db.prepare(
      `SELECT COUNT(*) as cnt FROM observations`
    ).first<{ cnt: number }>();
    return row?.cnt ?? 0;
  } catch (error) {
    console.error('Observation count query failed:', error);
    return 0;
  }
}

/**
 * Record a per-cycle summary to observations for longitudinal tracking.
 * Uses existing recordPlatformSignal — no new DB functions needed.
 */
export async function recordCycleSummary(
  db: D1Database,
  context: CycleContext,
  stats: {
    postsDiscovered: number;
    postsEngaged: number;
    postsSkipped: number;
    attacksCataloged: number;
    contextBoosts: number;
    contextPenalties: number;
    gatesFromContext: number;
  }
): Promise<void> {
  const hourBucket = context.cycleTimestamp.slice(0, 13); // YYYY-MM-DDTHH

  const summary = {
    ...stats,
    confidence: context.confidence,
    suppressedSubmolts: [...context.suppressedSubmolts],
    peakHourActive: context.peakAttackHours.has(new Date().getUTCHours()),
  };

  await recordPlatformSignal(
    db,
    `cycle_summary:${hourBucket}`,
    'system',
    JSON.stringify(summary)
  );
}
