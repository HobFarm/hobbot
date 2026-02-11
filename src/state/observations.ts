// Pattern observation tracking
// Populates the observations table with shape/pattern/platform frequency data

import type { D1Database } from "@cloudflare/workers-types";
import { safeD1Value } from "../utils/d1";

/**
 * Record a structural shape observation (upserts by type + shape_name)
 */
export async function recordShapeObservation(
  db: D1Database,
  shapeName: string,
  examplePostId: string
): Promise<void> {
  const now = new Date().toISOString();

  // Keep examples list bounded: store last 20 post IDs
  await db
    .prepare(
      `INSERT INTO observations (type, shape_name, count, examples, first_seen, last_seen)
       VALUES ('shape', ?, 1, ?, ?, ?)
       ON CONFLICT(type, shape_name) DO UPDATE SET
         count = count + 1,
         examples = CASE
           WHEN length(examples) - length(replace(examples, ',', '')) >= 19
           THEN substr(examples, instr(examples, ',') + 1) || ',' || ?
           ELSE examples || ',' || ?
         END,
         last_seen = ?`
    )
    .bind(
      safeD1Value(shapeName),
      safeD1Value(examplePostId),
      now,
      now,
      safeD1Value(examplePostId),
      safeD1Value(examplePostId),
      now
    )
    .run();
}

/**
 * Record an engagement pattern observation (e.g. seeking_help, structural_language)
 */
export async function recordEngagementPattern(
  db: D1Database,
  patternType: string,
  examplePostId: string
): Promise<void> {
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO observations (type, shape_name, count, examples, first_seen, last_seen)
       VALUES ('engagement_pattern', ?, 1, ?, ?, ?)
       ON CONFLICT(type, shape_name) DO UPDATE SET
         count = count + 1,
         examples = CASE
           WHEN length(examples) - length(replace(examples, ',', '')) >= 19
           THEN substr(examples, instr(examples, ',') + 1) || ',' || ?
           ELSE examples || ',' || ?
         END,
         last_seen = ?`
    )
    .bind(
      safeD1Value(patternType),
      safeD1Value(examplePostId),
      now,
      now,
      safeD1Value(examplePostId),
      safeD1Value(examplePostId),
      now
    )
    .run();
}

/**
 * Record a platform-level signal (per-post accumulation)
 * signalKey format: "category:key" e.g. "submolt_traffic:general", "attack_hour:03"
 * Uses type='platform' in observations table
 */
export async function recordPlatformSignal(
  db: D1Database,
  signalKey: string,
  examplePostId: string,
  metadata?: string
): Promise<void> {
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO observations (type, shape_name, count, examples, first_seen, last_seen, metadata)
       VALUES ('platform', ?, 1, ?, ?, ?, ?)
       ON CONFLICT(type, shape_name) DO UPDATE SET
         count = count + 1,
         examples = CASE
           WHEN length(examples) - length(replace(examples, ',', '')) >= 19
           THEN substr(examples, instr(examples, ',') + 1) || ',' || ?
           ELSE examples || ',' || ?
         END,
         last_seen = ?,
         metadata = COALESCE(?, metadata)`
    )
    .bind(
      safeD1Value(signalKey),
      safeD1Value(examplePostId),
      now,
      now,
      safeD1Value(metadata ?? null),
      safeD1Value(examplePostId),
      safeD1Value(examplePostId),
      now,
      safeD1Value(metadata ?? null)
    )
    .run();
}

/**
 * Upsert a platform insight (computed aggregate, type='platform_insight')
 * Called by computePlatformInsights during reflect phase
 */
export async function upsertPlatformInsight(
  db: D1Database,
  insightKey: string,
  metadata: string
): Promise<void> {
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO observations (type, shape_name, count, examples, first_seen, last_seen, metadata)
       VALUES ('platform_insight', ?, 1, '', ?, ?, ?)
       ON CONFLICT(type, shape_name) DO UPDATE SET
         count = count + 1,
         last_seen = ?,
         metadata = ?`
    )
    .bind(
      insightKey,
      now,
      now,
      metadata,
      now,
      metadata
    )
    .run();
}

// ============================================
// Batched variants (reduce subrequest count)
// ============================================

export interface PlatformSignalEntry {
  signalKey: string;
  examplePostId: string;
  metadata?: string;
}

export interface ShapeObservationEntry {
  shapeName: string;
  examplePostId: string;
}

export interface EngagementPatternEntry {
  patternType: string;
  examplePostId: string;
}

/**
 * Batch record multiple platform signals in a single db.batch() call.
 * Collapses N subrequests into 1.
 */
export async function recordPlatformSignalsBatch(
  db: D1Database,
  signals: PlatformSignalEntry[]
): Promise<void> {
  if (signals.length === 0) return;

  const now = new Date().toISOString();

  const batch = signals.map(sig =>
    db.prepare(
      `INSERT INTO observations (type, shape_name, count, examples, first_seen, last_seen, metadata)
       VALUES ('platform', ?, 1, ?, ?, ?, ?)
       ON CONFLICT(type, shape_name) DO UPDATE SET
         count = count + 1,
         examples = CASE
           WHEN length(examples) - length(replace(examples, ',', '')) >= 19
           THEN substr(examples, instr(examples, ',') + 1) || ',' || ?
           ELSE examples || ',' || ?
         END,
         last_seen = ?,
         metadata = COALESCE(?, metadata)`
    ).bind(
      safeD1Value(sig.signalKey),
      safeD1Value(sig.examplePostId),
      now,
      now,
      safeD1Value(sig.metadata ?? null),
      safeD1Value(sig.examplePostId),
      safeD1Value(sig.examplePostId),
      now,
      safeD1Value(sig.metadata ?? null)
    )
  );

  try {
    await db.batch(batch);
  } catch (error) {
    console.error(`platform_signal_batch: failed (${signals.length} signals), falling back`, error);
    for (const sig of signals) {
      try { await recordPlatformSignal(db, sig.signalKey, sig.examplePostId, sig.metadata); } catch (_) {}
    }
  }
}

/**
 * Batch record multiple shape observations in a single db.batch() call.
 */
export async function recordShapeObservationsBatch(
  db: D1Database,
  observations: ShapeObservationEntry[]
): Promise<void> {
  if (observations.length === 0) return;

  const now = new Date().toISOString();

  const batch = observations.map(obs =>
    db.prepare(
      `INSERT INTO observations (type, shape_name, count, examples, first_seen, last_seen)
       VALUES ('shape', ?, 1, ?, ?, ?)
       ON CONFLICT(type, shape_name) DO UPDATE SET
         count = count + 1,
         examples = CASE
           WHEN length(examples) - length(replace(examples, ',', '')) >= 19
           THEN substr(examples, instr(examples, ',') + 1) || ',' || ?
           ELSE examples || ',' || ?
         END,
         last_seen = ?`
    ).bind(
      safeD1Value(obs.shapeName),
      safeD1Value(obs.examplePostId),
      now,
      now,
      safeD1Value(obs.examplePostId),
      safeD1Value(obs.examplePostId),
      now
    )
  );

  try {
    await db.batch(batch);
  } catch (error) {
    console.error(`shape_observation_batch: failed (${observations.length} obs), falling back`, error);
    for (const obs of observations) {
      try { await recordShapeObservation(db, obs.shapeName, obs.examplePostId); } catch (_) {}
    }
  }
}

/**
 * Batch record multiple engagement patterns in a single db.batch() call.
 */
export async function recordEngagementPatternsBatch(
  db: D1Database,
  patterns: EngagementPatternEntry[]
): Promise<void> {
  if (patterns.length === 0) return;

  const now = new Date().toISOString();

  const batch = patterns.map(pat =>
    db.prepare(
      `INSERT INTO observations (type, shape_name, count, examples, first_seen, last_seen)
       VALUES ('engagement_pattern', ?, 1, ?, ?, ?)
       ON CONFLICT(type, shape_name) DO UPDATE SET
         count = count + 1,
         examples = CASE
           WHEN length(examples) - length(replace(examples, ',', '')) >= 19
           THEN substr(examples, instr(examples, ',') + 1) || ',' || ?
           ELSE examples || ',' || ?
         END,
         last_seen = ?`
    ).bind(
      safeD1Value(pat.patternType),
      safeD1Value(pat.examplePostId),
      now,
      now,
      safeD1Value(pat.examplePostId),
      safeD1Value(pat.examplePostId),
      now
    )
  );

  try {
    await db.batch(batch);
  } catch (error) {
    console.error(`engagement_pattern_batch: failed (${patterns.length} patterns), falling back`, error);
    for (const pat of patterns) {
      try { await recordEngagementPattern(db, pat.patternType, pat.examplePostId); } catch (_) {}
    }
  }
}
