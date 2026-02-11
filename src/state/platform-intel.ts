// Platform intelligence: aggregate analysis of Moltbook behavior patterns
// Runs hourly during reflect phase to derive insights from accumulated data

import type { D1Database } from '@cloudflare/workers-types';
import { upsertPlatformInsight } from './observations';
import { ATTACK_PEAK_MIN_COUNT } from '../config';

interface PlatformObservation {
  shape_name: string;
  count: number;
}

/**
 * Compute platform-level insights from accumulated data.
 * Queries platform signals and seen_posts to derive higher-order intelligence.
 * Returns number of insights computed.
 */
export async function computePlatformInsights(db: D1Database): Promise<number> {
  let insightsComputed = 0;

  try {
    // 1. Submolt bot density: ratio of bot signals to total traffic per submolt
    insightsComputed += await computeSubmoltBotDensity(db);

    // 2. Attack temporal clustering: identify peak attack hours
    insightsComputed += await computeAttackTemporalPattern(db);

    // 3. Discovery source effectiveness: avg score and engagement rate per source
    insightsComputed += await computeSourceEffectiveness(db);

    // 4. Submolt engagement profile: avg score, volume per submolt
    insightsComputed += await computeSubmoltProfiles(db);

    // 5. Gate distribution: which gates fire most often
    insightsComputed += await computeGateDistribution(db);
  } catch (error) {
    console.error('Platform insights computation error:', error);
  }

  return insightsComputed;
}

/**
 * Compute bot density per submolt from platform observations
 * bot_density = submolt_bots count / submolt_traffic count
 */
async function computeSubmoltBotDensity(db: D1Database): Promise<number> {
  // Get traffic counts per submolt
  const traffic = await db
    .prepare(
      `SELECT shape_name, count FROM observations
       WHERE type = 'platform' AND shape_name LIKE 'submolt_traffic:%'`
    )
    .all<PlatformObservation>();

  if (!traffic.results || traffic.results.length === 0) return 0;

  // Get bot counts per submolt
  const bots = await db
    .prepare(
      `SELECT shape_name, count FROM observations
       WHERE type = 'platform' AND shape_name LIKE 'submolt_bots:%'`
    )
    .all<PlatformObservation>();

  const botMap = new Map<string, number>();
  for (const row of bots.results || []) {
    const submolt = row.shape_name.replace('submolt_bots:', '');
    botMap.set(submolt, row.count);
  }

  let computed = 0;
  for (const row of traffic.results) {
    const submolt = row.shape_name.replace('submolt_traffic:', '');
    const botCount = botMap.get(submolt) ?? 0;
    const ratio = row.count > 0 ? botCount / row.count : 0;

    await upsertPlatformInsight(
      db,
      `bot_density:${submolt}`,
      JSON.stringify({
        ratio: Math.round(ratio * 100) / 100,
        bot_signals: botCount,
        total_traffic: row.count,
      })
    );
    computed++;
  }

  return computed;
}

/**
 * Identify peak attack hours from temporal observations
 */
async function computeAttackTemporalPattern(db: D1Database): Promise<number> {
  const hourData = await db
    .prepare(
      `SELECT shape_name, count FROM observations
       WHERE type = 'platform' AND shape_name LIKE 'attack_hour:%'
       ORDER BY count DESC`
    )
    .all<PlatformObservation>();

  if (!hourData.results || hourData.results.length === 0) return 0;

  // Calculate mean and find peaks (above mean)
  const counts = hourData.results.map(r => r.count);
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;

  const peaks = hourData.results
    .filter(r => r.count > mean && r.count >= ATTACK_PEAK_MIN_COUNT)
    .map(r => ({
      hour: r.shape_name.replace('attack_hour:', ''),
      count: r.count,
    }));

  const total = counts.reduce((a, b) => a + b, 0);

  await upsertPlatformInsight(
    db,
    'attack_peak_hours',
    JSON.stringify({
      peaks: peaks.map(p => p.hour),
      peak_counts: Object.fromEntries(peaks.map(p => [p.hour, p.count])),
      total_attacks: total,
      mean_per_hour: Math.round(mean * 10) / 10,
    })
  );

  return 1;
}

/**
 * Compute discovery source effectiveness from seen_posts
 */
async function computeSourceEffectiveness(db: D1Database): Promise<number> {
  const sourceStats = await db
    .prepare(
      `SELECT
         discovery_source,
         COUNT(*) as total,
         AVG(score) as avg_score,
         SUM(CASE WHEN engaged = 1 THEN 1 ELSE 0 END) as engaged_count
       FROM seen_posts
       WHERE discovery_source IS NOT NULL
         AND first_seen_at > datetime('now', '-24 hours')
       GROUP BY discovery_source`
    )
    .all<{
      discovery_source: string;
      total: number;
      avg_score: number;
      engaged_count: number;
    }>();

  if (!sourceStats.results || sourceStats.results.length === 0) return 0;

  let computed = 0;
  for (const row of sourceStats.results) {
    const engageRate = row.total > 0 ? row.engaged_count / row.total : 0;

    await upsertPlatformInsight(
      db,
      `source_effectiveness:${row.discovery_source}`,
      JSON.stringify({
        avg_score: Math.round((row.avg_score ?? 0) * 10) / 10,
        engage_rate: Math.round(engageRate * 100) / 100,
        total_24h: row.total,
        engaged_24h: row.engaged_count,
      })
    );
    computed++;
  }

  return computed;
}

/**
 * Compute engagement profiles per submolt
 */
async function computeSubmoltProfiles(db: D1Database): Promise<number> {
  const submoltStats = await db
    .prepare(
      `SELECT
         submolt,
         COUNT(*) as total,
         AVG(score) as avg_score,
         SUM(CASE WHEN engaged = 1 THEN 1 ELSE 0 END) as engaged_count,
         SUM(CASE WHEN score = 0 THEN 1 ELSE 0 END) as disqualified_count
       FROM seen_posts
       WHERE submolt IS NOT NULL
         AND first_seen_at > datetime('now', '-24 hours')
       GROUP BY submolt`
    )
    .all<{
      submolt: string;
      total: number;
      avg_score: number;
      engaged_count: number;
      disqualified_count: number;
    }>();

  if (!submoltStats.results || submoltStats.results.length === 0) return 0;

  let computed = 0;
  for (const row of submoltStats.results) {
    const engageRate = row.total > 0 ? row.engaged_count / row.total : 0;
    const disqualifyRate = row.total > 0 ? row.disqualified_count / row.total : 0;

    await upsertPlatformInsight(
      db,
      `submolt_profile:${row.submolt}`,
      JSON.stringify({
        avg_score: Math.round((row.avg_score ?? 0) * 10) / 10,
        engage_rate: Math.round(engageRate * 100) / 100,
        disqualify_rate: Math.round(disqualifyRate * 100) / 100,
        volume_24h: row.total,
        engaged_24h: row.engaged_count,
      })
    );
    computed++;
  }

  return computed;
}

/**
 * Compute gate hit distribution from decision logs
 */
async function computeGateDistribution(db: D1Database): Promise<number> {
  const gateStats = await db
    .prepare(
      `SELECT
         json_extract(decision_log, '$.gate') as gate,
         COUNT(*) as count
       FROM seen_posts
       WHERE decision_log IS NOT NULL
         AND json_extract(decision_log, '$.gate') IS NOT NULL
         AND first_seen_at > datetime('now', '-24 hours')
       GROUP BY json_extract(decision_log, '$.gate')`
    )
    .all<{ gate: string; count: number }>();

  if (!gateStats.results || gateStats.results.length === 0) return 0;

  const distribution: Record<string, number> = {};
  let total = 0;
  for (const row of gateStats.results) {
    distribution[row.gate] = row.count;
    total += row.count;
  }

  await upsertPlatformInsight(
    db,
    'gate_distribution',
    JSON.stringify({
      ...distribution,
      total_gated: total,
    })
  );

  return 1;
}
