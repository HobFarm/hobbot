// Database schema migrations for HobBot
// Run migrations with runMigrations(db) on startup

import type { D1Database } from "@cloudflare/workers-types";

interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "add_extraction_tracking",
    sql: `
      CREATE TABLE IF NOT EXISTS author_signals (
        author_hash TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        post_id TEXT NOT NULL,
        PRIMARY KEY (author_hash, timestamp)
      );

      CREATE INDEX IF NOT EXISTS idx_author_signals_author_time
      ON author_signals(author_hash, timestamp);
    `,
  },
  {
    version: 5,
    name: "add_own_posts",
    sql: `
      CREATE TABLE IF NOT EXISTS own_posts (
        post_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        title TEXT NOT NULL,
        submolt TEXT NOT NULL,
        last_checked_at TEXT,
        comment_count INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_own_posts_last_checked
      ON own_posts(last_checked_at ASC);
    `,
  },
  {
    version: 6,
    name: "migrate_self_posts_data",
    sql: `
      INSERT INTO own_posts (post_id, created_at, title, submolt, last_checked_at, comment_count)
      SELECT post_id, created_at, title, submolt, NULL, 0
      FROM self_posts
      WHERE NOT EXISTS (SELECT 1 FROM own_posts WHERE own_posts.post_id = self_posts.post_id);
    `,
  },
  {
    version: 7,
    name: "add_reply_queue",
    sql: `
      CREATE TABLE IF NOT EXISTS reply_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id TEXT NOT NULL,
        comment_id TEXT UNIQUE NOT NULL,
        author TEXT NOT NULL,
        content TEXT NOT NULL,
        reply_worthiness INTEGER NOT NULL,
        replied BOOLEAN DEFAULT FALSE,
        replied_at TEXT,
        our_reply TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_reply_queue_pending
      ON reply_queue(replied, reply_worthiness DESC);
    `,
  },
  {
    version: 8,
    name: "add_observations_metaphor_family",
    sql: `ALTER TABLE observations ADD COLUMN metaphor_family TEXT;`,
  },
  {
    version: 9,
    name: "add_reply_tracking",
    sql: `
      ALTER TABLE daily_budget ADD COLUMN replies_used INTEGER DEFAULT 0;
      ALTER TABLE daily_budget ADD COLUMN replies_max INTEGER DEFAULT 50;
      ALTER TABLE daily_budget ADD COLUMN last_reply_at TEXT;
    `,
  },
  {
    version: 10,
    name: "add_metaphor_family_tracking",
    sql: `ALTER TABLE daily_budget ADD COLUMN last_metaphor_family TEXT DEFAULT 'geometry';`,
  },
  {
    version: 18,
    name: "drift_attack_tracking",
    sql: `
      ALTER TABLE author_signals ADD COLUMN signal_type TEXT DEFAULT 'extraction';
      ALTER TABLE author_signals ADD COLUMN content_hash TEXT;
      ALTER TABLE author_signals ADD COLUMN emoji_signature TEXT;
      ALTER TABLE author_signals ADD COLUMN attack_type TEXT;

      CREATE INDEX IF NOT EXISTS idx_author_signals_type
      ON author_signals(author_hash, signal_type, timestamp);

      CREATE TABLE IF NOT EXISTS thread_author_activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        author_hash TEXT NOT NULL,
        comment_count INTEGER DEFAULT 1,
        escalation_detected BOOLEAN DEFAULT FALSE,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        UNIQUE(thread_id, author_hash)
      );

      CREATE INDEX IF NOT EXISTS idx_thread_activity
      ON thread_author_activity(thread_id, author_hash);

      CREATE TABLE IF NOT EXISTS thread_comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        author_hash TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        content_preview TEXT NOT NULL,
        timestamp TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_thread_comments_lookup
      ON thread_comments(thread_id, author_hash, timestamp DESC);
    `,
  },
  {
    version: 19,
    name: "add_title_hash",
    sql: `
      ALTER TABLE own_posts ADD COLUMN title_hash TEXT;

      CREATE INDEX IF NOT EXISTS idx_own_posts_title_hash_submolt
      ON own_posts(title_hash, submolt, created_at DESC);
    `,
  },
  {
    version: 20,
    name: "moltbook_engagement_tracking",
    sql: `
      -- Track submolt subscriptions
      ALTER TABLE submolts ADD COLUMN subscribed BOOLEAN DEFAULT FALSE;
      ALTER TABLE submolts ADD COLUMN subscribed_at TEXT;

      -- Track followed authors for quality assessment
      CREATE TABLE IF NOT EXISTS followed_authors (
        agent_name TEXT PRIMARY KEY,
        quality_score INTEGER DEFAULT 0,
        quality_posts INTEGER DEFAULT 0,
        followed_at TEXT,
        first_seen_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_followed_authors_score
      ON followed_authors(quality_score DESC);

      -- Track upvotes to avoid duplicates
      CREATE TABLE IF NOT EXISTS upvotes_given (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        author_name TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(target_type, target_id)
      );

      CREATE INDEX IF NOT EXISTS idx_upvotes_given_date
      ON upvotes_given(created_at DESC);

      -- Track DM requests for human notification
      CREATE TABLE IF NOT EXISTS dm_requests (
        conversation_id TEXT PRIMARY KEY,
        from_agent TEXT NOT NULL,
        message TEXT NOT NULL,
        received_at TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        human_notified_at TEXT
      );

      -- Extend daily_budget with upvote/follow tracking
      ALTER TABLE daily_budget ADD COLUMN upvotes_used INTEGER DEFAULT 0;
      ALTER TABLE daily_budget ADD COLUMN upvotes_max INTEGER DEFAULT 30;
      ALTER TABLE daily_budget ADD COLUMN follows_used INTEGER DEFAULT 0;
      ALTER TABLE daily_budget ADD COLUMN follows_max INTEGER DEFAULT 2;
    `,
  },
  {
    version: 21,
    name: "add_rate_limit_tracking",
    sql: `
      -- Track rate-limit state to avoid repeated 429 errors
      ALTER TABLE daily_budget ADD COLUMN rate_limited_until TEXT;
      ALTER TABLE daily_budget ADD COLUMN rate_limit_endpoint TEXT;
    `,
  },
  {
    version: 22,
    name: "separate_glossary_tracking",
    sql: `
      -- Separate glossary post tracking from regular posts
      -- This prevents glossary posts from blocking regular post cooldowns
      ALTER TABLE daily_budget ADD COLUMN last_glossary_at TEXT;
    `,
  },
  {
    version: 23,
    name: "intelligence_gathering",
    sql: `
      -- Add UNIQUE constraint so observations can use ON CONFLICT upsert
      CREATE UNIQUE INDEX IF NOT EXISTS idx_observations_type_shape
      ON observations(type, shape_name);

      -- Store score breakdown and discovery source on seen_posts
      ALTER TABLE seen_posts ADD COLUMN score_signals TEXT;
      ALTER TABLE seen_posts ADD COLUMN discovery_source TEXT;

      -- Agent profile intelligence table
      -- platform column future-proofs for post-Moltbook portability
      CREATE TABLE IF NOT EXISTS agent_profiles (
        agent_hash TEXT PRIMARY KEY,
        platform TEXT NOT NULL DEFAULT 'moltbook',
        username TEXT,
        karma INTEGER,
        follower_count INTEGER,
        post_count INTEGER,
        comment_count INTEGER,
        description TEXT,
        agent_created_at TEXT,
        quality_score REAL DEFAULT 0,
        interaction_count INTEGER DEFAULT 0,
        avg_post_score REAL,
        last_active_at TEXT,
        first_seen_at TEXT NOT NULL,
        last_updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_agent_profiles_quality
      ON agent_profiles(quality_score DESC);

      CREATE INDEX IF NOT EXISTS idx_agent_profiles_platform
      ON agent_profiles(platform, quality_score DESC);
    `,
  },
  {
    version: 24,
    name: "decision_provenance_and_platform",
    sql: `
      -- Decision provenance: full reasoning chain for every post
      ALTER TABLE seen_posts ADD COLUMN decision_log TEXT;

      -- Submolt as first-class dimension for platform analysis
      ALTER TABLE seen_posts ADD COLUMN submolt TEXT;
    `,
  },
  {
    version: 25,
    name: "own_posts_decision_log",
    sql: `
      ALTER TABLE own_posts ADD COLUMN decision_log TEXT;
    `,
  },
  {
    version: 26,
    name: "learning_loop_pattern_store",
    sql: `
      CREATE TABLE IF NOT EXISTS hobbot_patterns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pattern_id TEXT UNIQUE NOT NULL,
        pattern_name TEXT NOT NULL,
        category TEXT NOT NULL,
        structural_description TEXT NOT NULL,
        geometric_metaphor TEXT,
        observed_count INTEGER DEFAULT 1,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        source_context TEXT,
        related_patterns TEXT,
        generation_seeds TEXT,
        active INTEGER DEFAULT 1
      );

      CREATE INDEX IF NOT EXISTS idx_patterns_category
      ON hobbot_patterns(category, active);

      CREATE INDEX IF NOT EXISTS idx_patterns_active
      ON hobbot_patterns(active, last_seen_at DESC);

      CREATE TABLE IF NOT EXISTS hobbot_digest (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        content TEXT NOT NULL,
        pattern_count INTEGER DEFAULT 0,
        active_pattern_count INTEGER DEFAULT 0,
        patterns_since_rebuild INTEGER DEFAULT 0,
        built_at TEXT NOT NULL,
        digest_version INTEGER DEFAULT 1
      );
    `,
  },
  {
    version: 27,
    name: "observations_metadata_column",
    sql: `
      ALTER TABLE observations ADD COLUMN metadata TEXT;
    `,
  },
  {
    version: 28,
    name: "blacklisted_threads",
    sql: `
      CREATE TABLE IF NOT EXISTS blacklisted_threads (
        post_id TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        blacklisted_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_blacklist_expires ON blacklisted_threads(expires_at);
    `,
  },
  {
    version: 29,
    name: "memory_reflections",
    sql: `
      CREATE TABLE IF NOT EXISTS memory_reflections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cycle_timestamp TEXT NOT NULL,
        cycle_hour INTEGER NOT NULL,
        posts_discovered INTEGER DEFAULT 0,
        posts_engaged INTEGER DEFAULT 0,
        attacks_cataloged INTEGER DEFAULT 0,
        replies_sent INTEGER DEFAULT 0,
        learning_summary TEXT,
        knowledge_updates TEXT,
        anomalies TEXT,
        reflection_cost REAL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_reflections_cycle ON memory_reflections(cycle_timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_reflections_hour ON memory_reflections(cycle_hour);
    `,
  },
  {
    version: 30,
    name: "memory_knowledge",
    sql: `
      CREATE TABLE IF NOT EXISTS memory_knowledge (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        knowledge_type TEXT NOT NULL,
        knowledge_key TEXT NOT NULL,
        content TEXT NOT NULL,
        structured_data TEXT,
        confidence REAL DEFAULT 0.3,
        evidence_count INTEGER DEFAULT 1,
        first_created_at TEXT NOT NULL,
        last_updated_at TEXT NOT NULL,
        last_evidence_at TEXT NOT NULL,
        decay_applied_at TEXT,
        UNIQUE(knowledge_type, knowledge_key)
      );

      CREATE INDEX IF NOT EXISTS idx_knowledge_type_confidence ON memory_knowledge(knowledge_type, confidence DESC);
      CREATE INDEX IF NOT EXISTS idx_knowledge_last_evidence ON memory_knowledge(last_evidence_at ASC);
    `,
  },
  {
    version: 31,
    name: "sovereign_probes_negotiations",
    sql: `
      CREATE TABLE IF NOT EXISTS semantic_probes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query_text TEXT UNIQUE NOT NULL,
        category TEXT NOT NULL,
        last_used_at TEXT,
        use_count INTEGER DEFAULT 0,
        yield_count INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_semantic_probes_stale
      ON semantic_probes(last_used_at ASC);

      CREATE TABLE IF NOT EXISTS sovereign_territories (
        name TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        description TEXT NOT NULL,
        submolt_name TEXT NOT NULL,
        seeded INTEGER DEFAULT 0,
        seeded_at TEXT,
        strategy_profile TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS dm_negotiations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        negotiation_type TEXT NOT NULL,
        stage TEXT NOT NULL DEFAULT 'initiated',
        context TEXT,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT,
        outcome TEXT,
        UNIQUE(conversation_id, negotiation_type)
      );

      CREATE INDEX IF NOT EXISTS idx_dm_negotiations_active
      ON dm_negotiations(stage, last_activity_at DESC);
    `,
  },
  {
    version: 32,
    name: "lucid_dream",
    sql: `
      CREATE TABLE IF NOT EXISTS pattern_evolution (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pattern_id TEXT NOT NULL,
        snapshot_version INTEGER NOT NULL,
        structural_description TEXT NOT NULL,
        geometric_metaphor TEXT,
        observed_count INTEGER NOT NULL,
        generation_seeds TEXT,
        category TEXT NOT NULL,
        snapshot_at TEXT NOT NULL DEFAULT (datetime('now')),
        change_summary TEXT,
        UNIQUE(pattern_id, snapshot_version)
      );

      CREATE INDEX IF NOT EXISTS idx_pattern_evolution_pattern
      ON pattern_evolution(pattern_id, snapshot_version DESC);

      CREATE TABLE IF NOT EXISTS glossary_drafts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        term TEXT NOT NULL,
        definition TEXT NOT NULL,
        relevance TEXT NOT NULL,
        example TEXT NOT NULL,
        source_patterns TEXT,
        confidence REAL DEFAULT 0.5,
        status TEXT NOT NULL DEFAULT 'draft',
        promoted_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_glossary_drafts_status
      ON glossary_drafts(status, confidence DESC);

      CREATE TABLE IF NOT EXISTS dream_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        patterns_evolved INTEGER DEFAULT 0,
        research_findings INTEGER DEFAULT 0,
        glossary_drafts_created INTEGER DEFAULT 0,
        glossary_drafts_promoted INTEGER DEFAULT 0,
        synthesis_summary TEXT,
        token_cost REAL DEFAULT 0,
        error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_dream_runs_completed
      ON dream_runs(completed_at DESC);
    `,
  },
  {
    version: 33,
    name: "dream_enhancements",
    sql: `
      CREATE TABLE IF NOT EXISTS research_findings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dream_run_id INTEGER NOT NULL,
        pattern_id TEXT NOT NULL,
        pattern_name TEXT NOT NULL,
        query TEXT NOT NULL,
        post_count INTEGER NOT NULL,
        avg_score REAL NOT NULL,
        top_submolts TEXT,
        validation_signal TEXT NOT NULL,
        evidence_summary TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_research_findings_pattern
      ON research_findings(pattern_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_research_findings_dream
      ON research_findings(dream_run_id);

      CREATE TABLE IF NOT EXISTS dream_dm_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dream_run_id INTEGER NOT NULL,
        conversation_id TEXT NOT NULL,
        participant TEXT NOT NULL,
        signal_type TEXT NOT NULL,
        message_summary TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_dream_dm_signals_dream
      ON dream_dm_signals(dream_run_id);

      ALTER TABLE dream_runs ADD COLUMN dm_signals_found INTEGER DEFAULT 0;

      ALTER TABLE dream_runs ADD COLUMN community_vibe TEXT;
    `,
  },
];

export async function runMigrations(db: D1Database): Promise<void> {
  // Create migrations tracking table
  await db
    .prepare(
      `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `
    )
    .run();

  // Get already applied migrations
  const applied = await db
    .prepare("SELECT version FROM schema_migrations")
    .all<{ version: number }>();

  const appliedVersions = new Set(applied.results?.map((r) => r.version) ?? []);

  // Run pending migrations in order
  for (const migration of MIGRATIONS) {
    if (appliedVersions.has(migration.version)) {
      continue;
    }

    console.log(`Running migration ${migration.version}: ${migration.name}`);

    try {
      // Split multi-statement SQL and run each separately
      const statements = migration.sql
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      for (const statement of statements) {
        try {
          await db.prepare(statement).run();
        } catch (error) {
          // Gracefully handle "duplicate column name" errors for ALTER TABLE
          // This makes migrations idempotent when columns already exist
          const errMsg = error instanceof Error ? error.message : String(error);
          if (statement.toUpperCase().includes('ALTER TABLE') &&
              errMsg.toLowerCase().includes('duplicate column')) {
            console.log(`Column already exists, continuing: ${statement.slice(0, 60)}...`);
            continue;
          }
          throw error;
        }
      }

      // Record successful migration
      await db
        .prepare(
          `INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)`
        )
        .bind(migration.version, migration.name, new Date().toISOString())
        .run();

      console.log(`Migration ${migration.version} completed`);
    } catch (error) {
      console.error(`Migration ${migration.version} failed:`, error);
      throw error;
    }
  }
}
