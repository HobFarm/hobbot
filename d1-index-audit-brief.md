## Task: D1 Index Audit and Row Read Optimization
## Project: Grimoire + HobBot (cross-worker)
## Context: April 2026 billing shows $35.64 in D1 row reads (60.64B rows, 35.64B billable) over ~3 weeks. This is the dominant cost driver at 69% of total spend. The spike correlates with the 9-phase enhancement deploy (early April). Suspected causes: unindexed queries in the enrichment pipeline, daily review aggregations, and retention crons. The actual data volume is small (177K atoms, correspondences, documents); this cost is entirely from scan inefficiency, not data scale.

### Current State

Query the following databases to determine current index coverage:

- `grimoire-db` (Grimoire worker): atoms, correspondences, arrangements, categories, collections, documents, chunks, chunk_embeddings
- `HOBBOT_DB` (HobBot gateway): hobbot_actions, tool_executions, plus any pipeline/custodian tables

Run `.schema` or `PRAGMA table_info(tablename)` and `PRAGMA index_list(tablename)` on every table in both databases to get the full picture.

### Target State

1. A diagnostic report listing every query hotspot: which queries scan the most rows and where they originate in the codebase.
2. Covering indexes added for every identified hotspot.
3. D1 billable row reads drop to near-zero (well within the 25B free tier) for normal operational load.

### Phase 1: Discovery (read-only, no changes)

For each database, run:

```sql
-- List all tables
SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;

-- For each table, check existing indexes
PRAGMA index_list('table_name');
PRAGMA index_info('index_name');

-- Row counts to understand data scale
SELECT COUNT(*) FROM table_name;
```

Then grep the codebase for every D1 query pattern. Focus on these high-suspicion areas:

**Grimoire worker (`workers/grimoire/src/`):**
- Enrichment pipeline chunk selection: how does it find unenriched chunks? If it's `SELECT * FROM chunks WHERE enriched = 0` without an index on `enriched`, every call scans the full chunks table.
- Correspondence lookups by atom_id: these happen on every enrichment cycle and every chat query. Check for index on `atom_id` (both sides of the correspondence).
- Category/arrangement fetches: less likely to be the problem (small tables), but verify.
- Vectorize-related queries: the 352M queried dimensions suggest heavy vector search; check if there's a D1 pre-filter query before each Vectorize call.

**HobBot gateway (`workers/hobbot-worker/src/`):**
- `tool_executions` retention cron: `DELETE FROM tool_executions WHERE created_at < ?` needs an index on `created_at`.
- `hobbot_actions` retention cron: same pattern, 90-day window. Index on `created_at`.
- Daily review pipeline: 9 parallel queries aggregating across Grimoire tables. Check each query's access pattern.

**HobBot pipeline (`workers/hobbot-pipeline/src/`):**
- RSS ingestion queries: selecting existing items to deduplicate.
- Pipeline phase queries: selecting items by status/phase.

**HobBot custodian (`workers/hobbot-custodian/src/`):**
- All 7 cron phases: each one queries D1. Check every SELECT and DELETE for index coverage.

**Grimoire classifier (`workers/grimoire-classifier/src/`):**
- Classification batch selection: how does it pick atoms to classify?

### Phase 2: Index Creation

For each identified hotspot, create the appropriate index. Use `CREATE INDEX IF NOT EXISTS` for idempotency.

Naming convention: `idx_{table}_{column}` or `idx_{table}_{col1}_{col2}` for composites.

Common patterns that almost certainly need indexes if missing:

```sql
-- Chunk enrichment selection
CREATE INDEX IF NOT EXISTS idx_chunks_enriched ON chunks(enriched);

-- Correspondence lookups (both directions)
CREATE INDEX IF NOT EXISTS idx_correspondences_source ON correspondences(source_atom_id);
CREATE INDEX IF NOT EXISTS idx_correspondences_target ON correspondences(target_atom_id);

-- Retention cron deletes
CREATE INDEX IF NOT EXISTS idx_tool_executions_created ON tool_executions(created_at);
CREATE INDEX IF NOT EXISTS idx_hobbot_actions_created ON hobbot_actions(created_at);

-- Pipeline phase selection
CREATE INDEX IF NOT EXISTS idx_hobbot_actions_status ON hobbot_actions(status);
```

Do NOT blindly apply these. Verify actual query patterns first. Some may already exist; some may need composite indexes instead.

### Phase 3: Query Optimization

Beyond indexing, check for these anti-patterns:

1. **SELECT * where only specific columns are needed.** Especially on tables with large text columns (atom descriptions, chunk content). Narrow the SELECT list.
2. **Unbounded SELECTs without LIMIT.** Any query that could return thousands of rows should have a LIMIT unless it's an intentional full-table aggregation.
3. **Repeated identical queries in loops.** If enrichment processes each chunk individually and re-fetches categories/arrangements on every iteration, hoist those lookups outside the loop.
4. **JOIN without index on join column.** Any JOIN on a column that isn't indexed forces a scan of the joined table for every row in the driving table.

### Files to Touch

Discovery phase (read-only):
- `workers/grimoire/src/` (all .ts files with D1 queries)
- `workers/hobbot-worker/src/` (gateway, retention crons, daily review)
- `workers/hobbot-pipeline/src/` (pipeline phases)
- `workers/hobbot-custodian/src/` (all 7 cron phases)
- `workers/grimoire-classifier/src/` (classification queries)

Implementation phase:
- Create a migration file or apply indexes directly via wrangler d1 execute
- Modify any queries found to have anti-patterns (SELECT *, missing LIMIT, loop-hoisted fetches)

### Implementation Notes

- D1 is SQLite under the hood. SQLite's query planner is good but relies heavily on indexes. Without them, everything is a full table scan.
- `EXPLAIN QUERY PLAN` works on D1 and is the definitive way to check if a query uses an index. Run it on every suspected hotspot.
- D1 prepared statements have ~100 binding variable limit. If any bulk operations are building large IN() clauses, they may be chunking at 80 (per existing convention). Verify these are indexed on the IN() column.
- Creating indexes on D1 is a one-time write cost. The ongoing read savings vastly outweigh it.
- The self-chaining enrichment pipeline (`/internal/enrich-continue`) runs up to depth 20. Each iteration's queries compound. Even small per-query inefficiencies multiply by chain depth times batch size.

### Verification

1. Run `EXPLAIN QUERY PLAN` on every modified query. Confirm all show `USING INDEX` instead of `SCAN TABLE`.
2. After deploying indexes, monitor D1 row reads in the Cloudflare billing dashboard for 48 hours.
3. Target: daily D1 cost should drop from the current ~$1.50-2.50/day range to effectively $0 (within free tier).
4. Run the enrichment pipeline manually on a small batch and confirm row reads are proportional to batch size, not total table size.
