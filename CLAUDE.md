# HobBot Gateway (hobbot-worker) + Shared Module Catalog

> CC: Read this file together with the root [CLAUDE.md](../CLAUDE.md) before starting work. The root file owns architecture, schema conventions, deploy rules, and the documented exceptions list. This file owns the gateway worker's bindings + the catalog of shared modules under `src/shared/` that every worker imports.
>
> `HobBot/` is a separate git repository nested inside the grimoire tree (own `.git`, excluded from grimoire `.gitignore`, **not** included in grimoire git worktrees). Builds for any `hobbot-*` worker fail in worktrees because `@shared/*` resolves to `../../HobBot/src/*`. Always work from the main checkout.

**LAST_UPDATED:** 2026-05-08. If more than seven days old, treat specific claims as suspect — see [Stale Instruction Policy](../CLAUDE.md#stale-instruction-policy).

## What This Worker Does

API surface for the entire HobBot swarm. Serves MCP tools, HTTP API routes, and delegates heavy operations to child workers via Cloudflare Service Bindings (zero-cost, same-thread RPC). Also serves the MCP endpoint that claude.ai connects to.

The gateway has no AI providers and no R2. Its only cron is a daily 3am UTC retention cleanup on HOBBOT_DB tables it owns (`tool_executions`, `hobbot_actions`, `token_usage`); see the `scheduled()` handler in [src/index.ts](src/index.ts). Pure routing otherwise.

**Plasticity substrate posture.** The gateway is a read-only consumer of the plasticity substrate. It never invokes `reinforcePair`, `reinforceFromDiscovery`, or `buildInsertWithContribution` — all `correspondences` mutation goes through the grimoire worker via the `GRIMOIRE` service binding. See the [Write-Path Registry](../CLAUDE.md#write-path-registry) in the root CLAUDE.md.

## Worker Bindings

Verify against `wrangler.toml` before making changes.

| Binding | Type | Purpose |
|---------|------|---------|
| GRIMOIRE_DB | D1 (grimoire-db) | Read-only. Direct Grimoire queries for MCP tools. |
| HOBBOT_DB | D1 (hobbot-db) | Read-write. Subscribers, blog draft CRUD. |
| PROVIDER_HEALTH | KV | Circuit breaker state (optional, used by shared code) |
| GRIMOIRE | Service binding → grimoire worker | Search, taxonomy, classify |
| HOBBOT_CHAT | Service binding → hobbot-chat | Chat proxy (fetch-based, not RPC) |
| HOBBOT_CUSTODIAN | Service binding → CustodianEntrypoint | Harvester, conductor, agent RPC |
| HOBBOT_PIPELINE | Service binding → PipelineEntrypoint | Ingest, blog, enrichment RPC |
| SERVICE_TOKENS | Secrets Store | Service auth tokens |
| RESEND_API_KEY | Wrangler secret | Resend email API for newsletters |

### Environment Variables

| Var | Value | Purpose |
|-----|-------|---------|
| ENVIRONMENT | "production" | Environment flag |

## The Swarm Topology

```
hobbot-worker (THIS WORKER - gateway)
  MCP server, HTTP API, newsletter
  Cron: 0 3 * * * (daily 3am UTC HOBBOT_DB retention cleanup)
  No AI, no R2
  │
  ├── hobbot-chat (Service Binding: HOBBOT_CHAT, fetch proxy)
  │     Chat backend, Anthropic Claude, session cookie auth
  │     Cron: daily 4am UTC (session purge)
  │
  ├── hobbot-custodian (Service Binding: HOBBOT_CUSTODIAN#CustodianEntrypoint)
  │     Harvesters, integrity, conductor, archive.org agent
  │     Crons: 0 */6 * * * | 0 0 * * 1 | 0 2 * * 1 | 0 3 * * 3
  │
  ├── hobbot-pipeline (Service Binding: HOBBOT_PIPELINE#PipelineEntrypoint)
  │     Knowledge ingest, blog pipeline, chunk enrichment, SF outcomes
  │     Crons: 0 */6 * * * | 0 5 * * * | 0 8 * * *
  │
  └── grimoire (Service Binding: GRIMOIRE)
        Knowledge graph owner, classification, vectorization, search, taxonomy
        Cron: */15 * * * * (6-phase queue feeder)
        Queues: classify, discovery, vectorize, enrich

  hobbot-agent (INDEPENDENT - Durable Object, not a service binding)
        Autonomous X content agent, 7-phase pipeline
        Schedules: Agent SDK (3x daily content, signals, engagement, calendar review)

  grimoire-classifier (INDEPENDENT - manual trigger only)
        Bulk classification and harmonization
        No crons, no queues
```

## HTTP Routes

| Method | Route | Handler | Purpose |
|--------|-------|---------|---------|
| * | /mcp, /mcp/* | createMcpHandler | MCP server (claude.ai connection point) |
| GET | / | healthResponse | Health digest with Grimoire stats |
| * | /api/* | handleApiRequest | API routes (see below) |

### API Routes (delegated from /api/*)

Handled by `src/api/routes.ts`. Routes delegate to child workers via RPC or handle directly.

#### Pipeline RPC (via HOBBOT_PIPELINE)

| Method | Route | RPC Call |
|--------|-------|---------|
| POST | /api/v1/ingest/knowledge | pipeline.ingestFromUrl() |
| POST | /api/v1/ingest/text | pipeline.ingestFromText() |
| POST | /api/v1/ingest/knowledge/batch | pipeline.ingestBatch() |
| POST | /api/v1/ingest/image | pipeline.ingestFromImage() |
| POST | /api/v1/ingest/pdf | pipeline.ingestFromPdf() |
| POST | /api/v1/ingest/reddit | pipeline.ingestFromReddit() |
| POST | /api/v1/classify/image | pipeline.classifyImage() |
| POST | /api/v1/blog/run | pipeline.runBlogPipeline() |
| POST | /api/v1/blog/bridge | pipeline.runBridge() |
| POST | /api/v1/blog/drafts/:id/publish | pipeline.publishDraft() |

#### Custodian RPC (via HOBBOT_CUSTODIAN)

| Method | Route | RPC Call |
|--------|-------|---------|
| POST | /api/v1/admin/harvest/:source_id | custodian.harvest() |
| POST | /api/v1/admin/build-correspondences/:id | custodian.buildCorrespondences() |
| POST | /api/v1/admin/process-discovery | custodian.processDiscovery() |
| GET | /api/v1/admin/harvest-health/:slug | custodian.harvestHealth() |
| POST | /api/v1/admin/conductor | custodian.runConductor() |
| POST | /api/v1/admin/agent/:name | custodian.runAgent() |
| GET | /api/v1/admin/knowledge-requests | custodian.listKnowledgeRequests() |

#### Chat Proxy (via HOBBOT_CHAT)

| Method | Route | Delegation |
|--------|-------|-----------|
| * | /api/chat/* | env.HOBBOT_CHAT.fetch(request) (full request proxy, not RPC) |

#### Direct Gateway Handlers (no delegation)

MCP tools and API routes that query D1 directly without AI:

- grimoire_search, grimoire_lookup, grimoire_ingest (atom-level)
- grimoire_correspondences, grimoire_recommend
- Document CRUD, relations, provider behaviors, discovery queue
- Newsletter subscription (Resend API)

## MCP Server

Served at `/mcp`. This is the endpoint claude.ai connects to at `hobbot-worker.damp-violet-bf89.workers.dev/mcp`.

MCP tools are defined in `src/mcp/server.ts`. Tool list is cached at session level in claude.ai. After deploying new tools, the MCP client must reconnect to pick up the fresh tool list.

Tools that query D1 directly execute in the gateway. Tools that require AI or pipeline processing delegate to child workers via RPC.

## File Structure

```
HobBot/
  src/
    index.ts              # Fetch handler: MCP, health, API routing
    mcp/
      server.ts           # MCP tool definitions (createGrimoireMcpServer)
    api/
      routes.ts           # API route handler (delegation + direct)
      auth.ts             # Service token auth
      subscribe.ts        # Newsletter subscription (Resend)
      blog-routes.ts      # Blog API routes
    pipeline/
      digest.ts           # Health digest builder
      ...                 # Other shared pipeline utilities
    grimoire/             # SHARED: handle, ingest, types, immune, telemetry
    state/                # SHARED: grimoire, documents, discovery, graph, relations, sources, ingest-log, audit, budget
    providers/            # SHARED: gemini, workers-ai, index, types
    rpc/                  # SHARED: pipeline-types.ts
    config.ts             # SHARED: constants
    models.ts             # SHARED: model registry
    ledger.ts             # SHARED: session ledger
  wrangler.toml
  CLAUDE.md               # This file
```

### Shared Module Catalog (`HobBot/src/`)

Imported by every worker via `@shared/*` tsconfig path alias (`paths: { "@shared/*": ["../../HobBot/src/*"] }`). **Do not delete or move these without auditing every worker that imports them.**

#### Top level

| Module | Purpose |
|--------|---------|
| config.ts | Cross-worker constants (chat caps, custodian scan limits, query bounds) |
| logger.ts | Structured JSON logger factory for Cloudflare log search |
| ledger.ts | Session-action ledger (ingestion, generation, posting, failure) |
| models.ts | **Authoritative model registry**. Task-keyed entries with primary + fallback chains. Single source of truth for every worker's model strings. |

#### Provider abstraction (`providers/`)

| Module | Purpose |
|--------|---------|
| index.ts | `getProvider()` factory + `callWithFallback()` utility |
| workers-ai.ts | `WorkersAIProvider` (edge-native via `env.AI.run()`) |
| gemini.ts | `GeminiProvider` (HTTP through AI Gateway, falls back to direct Google API on 401) |
| call-with-json-parse.ts | Unified JSON-output wrapper: retry, fallback, think-block stripping, schema validation |
| token-log.ts | Token usage logger |
| types.ts | Provider interface definitions |

#### Grimoire query layer (`grimoire/` + `state/`)

| Module | Purpose |
|--------|---------|
| grimoire/handle.ts | `GrimoireHandle` factory — public query interface; delegates to `state/` for SQL |
| grimoire/ingest.ts | `ingestAtom()` write path (sanitize, validate, insert, hook enqueue) |
| grimoire/immune.ts | AI duplicate detection (semantic equivalence check) |
| grimoire/types.ts | Core domain types (GrimoireAtom, Arrangement, Category, Collection, IntegrityIssue, …) |
| grimoire/telemetry.ts | Telemetry tracking |
| state/grimoire.ts | Atoms, arrangements, categories, collections (authoritative D1 layer) |
| state/documents.ts | documents + document_chunks queries |
| state/graph.ts | atom_relations, correspondences, graph traversal |
| state/relations.ts | Atom relation queries |
| state/discovery.ts | discovery_queue queries |
| state/sources.ts | Content source tracking |
| state/audit.ts | Audit log queries |
| state/budget.ts | Budget tracking |
| state/dirty-flags.ts | KV-backed cron phase optimization (used by grimoire worker) |
| state/ingest-log.ts | Ingest tracking |

#### RPC contracts (`rpc/`)

| Module | Purpose |
|--------|---------|
| pipeline-types.ts | Shared types for `hobbot-pipeline` (NormalizedDocument, ChunkResult, PipelineResult, param shapes) |

#### Pipeline utilities (`pipeline/`)

| Module | Purpose |
|--------|---------|
| validate.ts | Shared validation helpers |
| sanitize.ts | Input sanitization |
| digest.ts | Health digest builder |
| decision-trace.ts | Decision logging |

#### Tools / MCP (`tools/`, `mcp/`, `clients/`)

| Module | Purpose |
|--------|---------|
| tools/manifests/grimoire.ts | Grimoire tool manifest (the canonical tool catalog) |
| tools/generators.ts | `toChatToolDef`, `registerMcpTool` — convert manifests into chat-tool and MCP-tool defs |
| tools/hooks.ts | Pre/post hook system |
| mcp/server.ts | MCP server implementation (gateway-side) |
| mcp/admin-tools.ts | Read-only admin tool definitions |
| mcp/admin-write-tools.ts | Write-capable admin tool definitions |
| clients/archive-org.ts | Internet Archive API client (rate-limited, retry) — used by hobbot-custodian |

## Rules for CC

### Before Any Change

1. Read this file
2. Read wrangler.toml to verify bindings
3. If touching MCP tools, understand which tools execute locally vs delegate via RPC
4. If touching API routes, check src/api/routes.ts for the full route table
5. If touching shared code, understand that ALL child workers depend on it
6. If adding a new RPC method, the child worker's Entrypoint class must export it first

### Multi-Agent Safety

- Do not create, apply, or drop git stash entries unless explicitly asked
- Do not switch branches unless explicitly asked
- When committing, scope to your changes only
- File references must be repo-root relative (e.g. HobBot/src/mcp/server.ts)

### Code Rules

- No AI calls in the gateway. Delegate to child workers.
- No new crons. The single existing cron (3am UTC retention cleanup on gateway-owned HOBBOT_DB tables) is intentional; all *other* scheduled work belongs on child workers.
- No R2 operations. Pipeline worker owns R2.
- MCP tools that need AI must delegate via RPC, not add AI bindings here.
- Service token auth for admin endpoints (src/api/auth.ts)
- New RPC delegations must match the child worker's Entrypoint method signature exactly
- All model strings come from the shared MODELS registry in src/models.ts. No hardcoded model strings in worker code.
- Verify Workers AI model strings against https://developers.cloudflare.com/workers-ai/models/ not `wrangler ai models --search`, which has incomplete coverage of non-text-generation models (object detection, summarization, etc.).

### D1 Migrations

HobBot writes to `hobbot-db` (binding `HOBBOT_DB`), with migrations at `HobBot/migrations/hobbot/`. Apply via `npx wrangler d1 migrations apply hobbot-db --remote` from the `HobBot/` directory.

**Rules are identical to the grimoire worker.** See [workers/grimoire/CLAUDE.md](../workers/grimoire/CLAUDE.md) "D1 Migrations" section for the full list (idempotent migrations, never use `--command/--file` for schema, sequential numbering, table-rebuild pattern for CHECK changes, manual-apply requires immediate `INSERT INTO d1_migrations`). The cross-cutting Migration Safety Rules in the [root CLAUDE.md](../CLAUDE.md) also apply.

For current state, run `ls HobBot/migrations/hobbot/` and query the remote `d1_migrations` table — those are authoritative.

### What NOT To Do

- Do not add new crons to this worker. The single existing 3am UTC retention cleanup is intentional; new scheduled work belongs on child workers.
- Do not add AI, R2, Gemini, or Anthropic bindings
- Do not import from child worker source directories (blog/, chat/, harvesters/, agents/)
- Do not write to GRIMOIRE_DB except through grimoire/ingest.ts for atom-level operations
- Do not delete shared code from grimoire/, state/, providers/, config.ts, models.ts, ledger.ts
- Do not change the MCP endpoint path (/mcp). External clients depend on it.

## Build and Deploy

```bash
cd HobBot
npm run build
npx wrangler deploy
```

The cross-cutting Deploy Rules live in the [root CLAUDE.md](../CLAUDE.md#deploy-rules) — read those first (they cover deploy order, the worktree warning, the git-status precheck, the `git diff --name-only` rule, and the post-task commit requirement).

After deploying, verify:
- Health endpoint returns OK: `curl https://hobbot-worker.damp-violet-bf89.workers.dev/`
- MCP tools visible in claude.ai (may require MCP client reconnection)

## Relationship to Other Workers

| Worker | Binding | Communication Pattern |
|--------|---------|----------------------|
| hobbot-chat | HOBBOT_CHAT (Fetcher) | Full request proxy via fetch() |
| hobbot-custodian | HOBBOT_CUSTODIAN (CustodianEntrypoint) | Typed RPC via WorkerEntrypoint |
| hobbot-pipeline | HOBBOT_PIPELINE (PipelineEntrypoint) | Typed RPC via WorkerEntrypoint |
| grimoire | GRIMOIRE (Fetcher) | Service binding fetch (not RPC) |
| hobbot-agent | None | Independent. No gateway dependency. |
| grimoire-classifier | None | Independent. Manual trigger only. |
