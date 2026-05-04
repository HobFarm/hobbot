# HobBot Gateway (hobbot-worker)

> CC: Read this file completely before starting any task.
> This file describes architecture and behavior, not current state.
> Never cite counts or model version strings from this file.
> Query the actual database or worker config for current values.

## What This Worker Does

API surface for the entire HobBot swarm. Serves MCP tools, HTTP API routes, and delegates heavy operations to child workers via Cloudflare Service Bindings (zero-cost, same-thread RPC). Also serves the MCP endpoint that claude.ai connects to.

The gateway has NO crons, NO AI providers, NO R2. Pure routing layer.

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
| ENVIRONMENT | "development" | Environment flag (note: set to development, not production) |

## The Swarm Topology

```
hobbot-worker (THIS WORKER - gateway)
  MCP server, HTTP API, newsletter
  No crons, no AI, no R2
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

### Shared Code (Critical)

`HobBot/src/` contains shared code imported by ALL child workers via tsconfig paths alias:

```json
{ "compilerOptions": { "paths": { "@shared/*": ["../../HobBot/src/*"] } } }
```

**Do not delete these directories.** Every child worker depends on them:

| Directory | Used By | Purpose |
|-----------|---------|---------|
| grimoire/ | All workers | GrimoireHandle, ingest, types, immune, telemetry |
| state/ | All workers | D1 query modules for all tables |
| providers/ | pipeline, grimoire, custodian | Gemini, Workers AI provider wrappers, factory |
| rpc/ | pipeline, gateway | NormalizedDocument, PipelineResult, param types |
| config.ts | All workers | Shared constants |
| models.ts | All workers | Model registry, task-to-model mapping (single source of truth for all workers) |
| ledger.ts | pipeline, custodian | Session ledger logging |

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
- No crons. All scheduled work runs on child workers.
- No R2 operations. Pipeline worker owns R2.
- MCP tools that need AI must delegate via RPC, not add AI bindings here.
- Service token auth for admin endpoints (src/api/auth.ts)
- New RPC delegations must match the child worker's Entrypoint method signature exactly
- All model strings come from the shared MODELS registry in src/models.ts. No hardcoded model strings in worker code.
- Verify Workers AI model strings against https://developers.cloudflare.com/workers-ai/models/ not `wrangler ai models --search`, which has incomplete coverage of non-text-generation models (object detection, summarization, etc.).

### D1 Migrations

HobBot writes to `hobbot-db` (binding `HOBBOT_DB`), with migrations at `HobBot/migrations/hobbot/`. Apply via `npx wrangler d1 migrations apply hobbot-db --remote` from the `HobBot/` directory.

**Rules are identical to the grimoire worker.** See `workers/grimoire/CLAUDE.md` "D1 Migrations" section for the full list (idempotent migrations, never use `--command/--file` for schema, sequential numbering, table-rebuild pattern for CHECK changes, manual-apply requires immediate `INSERT INTO d1_migrations`).

Current state (post-reconciliation 2026-05-04): 14 migrations on disk (`0001_hobbot_agent.sql` → `0014_feed_entries_check_expand.sql`), all recorded in `d1_migrations`. Clean.

### What NOT To Do

- Do not add crons to this worker
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

Always build before deploy. Always `--remote` for D1 commands.

**Deploy order (children first, gateway last):**
```
hobbot-chat → hobbot-custodian → hobbot-pipeline → hobbot-worker
```

This order matters because the gateway's service bindings reference child workers. If a child worker adds a new RPC method, deploy the child first so the method exists when the gateway tries to call it.

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
