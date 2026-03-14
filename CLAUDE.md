# HobBot Gateway (hobbot-worker)

> CC: Read this file completely before starting any task.
> This file describes architecture and behavior, not current state.
> Query the actual database or worker config for current values.

## What This Worker Is

The HobBot gateway is the API surface for the entire HobBot swarm. It serves MCP tools, HTTP API routes, and delegates heavy operations to child workers via Cloudflare Service Bindings (zero-cost, same-thread RPC).

The gateway has NO crons, NO AI providers, NO R2. It's a pure routing layer.

## The Swarm

```
hobbot-worker (THIS WORKER)
  Gateway: MCP server, HTTP API, newsletter
  Bindings: GRIMOIRE_DB (R), HOBBOT_DB (RW), GRIMOIRE, SERVICE_TOKENS
  Crons: none
  |
  +-- hobbot-chat (Service Binding: HOBBOT_CHAT)
  |     Chat backend, Anthropic Claude, CF Access JWT auth
  |     Crons: none
  |
  +-- hobbot-custodian (Service Binding: HOBBOT_CUSTODIAN#CustodianEntrypoint)
  |     Harvesters (RSS, Getty AAT, Wikidata), integrity scanning, evolve reports
  |     Crons: 0 */6 * * * | 0 0 * * 1 | 0 2 * * 1 | 0 3 * * 3
  |
  +-- hobbot-pipeline (Service Binding: HOBBOT_PIPELINE#PipelineEntrypoint)
  |     Knowledge ingest, blog pipeline, chunk enrichment, SF outcomes
  |     Crons: 0 */6 * * * | 0 5 * * * | 0 8 * * *
  |
  +-- grimoire (Service Binding: GRIMOIRE)
        Atom classifier/vectorizer, search, taxonomy
        Crons: none
```

## RPC Delegation

MCP tools and API routes delegate to child workers via typed RPC (WorkerEntrypoint):

| MCP Tool / API Route | Delegated To |
|---------------------|-------------|
| `grimoire_ingest_knowledge`, `POST /api/v1/ingest/knowledge` | `pipeline.ingestFromUrl()` |
| `grimoire_ingest_text`, `POST /api/v1/ingest/text` | `pipeline.ingestFromText()` |
| `grimoire_ingest_batch`, `POST /api/v1/ingest/knowledge/batch` | `pipeline.ingestBatch()` |
| `grimoire_classify_image` | `pipeline.classifyImage()` |
| `grimoire_ingest_image` | `pipeline.ingestFromImage()` |
| `POST /api/v1/blog/run` | `pipeline.runBlogPipeline()` |
| `POST /api/v1/blog/bridge` | `pipeline.runBridge()` |
| `POST /api/v1/blog/drafts/:id/publish` | `pipeline.publishDraft()` |
| `POST /api/v1/admin/harvest/:source_id` | `custodian.harvest()` |
| `POST /api/v1/admin/build-correspondences/:id` | `custodian.buildCorrespondences()` |
| `POST /api/v1/admin/process-discovery` | `custodian.processDiscovery()` |
| `GET /api/v1/admin/harvest-health/:slug` | `custodian.harvestHealth()` |
| `POST /api/chat/*` | `env.HOBBOT_CHAT.fetch(request)` (proxy) |

Tools that stay in the gateway (direct DB, no AI): `grimoire_search`, `grimoire_lookup`, `grimoire_ingest` (atom-level), `grimoire_correspondences`, `grimoire_recommend`, document CRUD, relations, provider behaviors, discovery queue.

## Shared Code Pattern

HobBot/src/ contains shared code imported by child workers via tsconfig `paths` alias:

```json
// workers/hobbot-*/tsconfig.json
{ "compilerOptions": { "paths": { "@shared/*": ["../../HobBot/src/*"] } } }
```

esbuild (wrangler's bundler) resolves this natively. Shared modules accept `D1Database`, `Ai`, etc. as parameters, not `Env`.

**Shared directories (do not delete):**
- `grimoire/` (handle, ingest, types, immune, telemetry)
- `state/` (grimoire, documents, discovery, graph, relations, sources, ingest-log, audit, budget)
- `providers/` (gemini, workers-ai, index, types)
- `pipeline/` (digest, decision-trace, sanitize, validate)
- `rpc/pipeline-types.ts`
- `config.ts`, `models.ts`, `ledger.ts`

**Gateway-only files:**
- `index.ts`, `mcp/server.ts`
- `api/routes.ts`, `api/auth.ts`, `api/subscribe.ts`, `api/blog-routes.ts`

## Env Bindings

```typescript
interface Env {
  GRIMOIRE_DB: D1Database    // read-only from gateway
  HOBBOT_DB: D1Database      // read-write (subscribers, blog draft CRUD)
  SERVICE_TOKENS: string     // Secrets Store
  PROVIDER_HEALTH?: KVNamespace
  GRIMOIRE: Fetcher          // grimoire worker service binding
  ENVIRONMENT: 'development' | 'production'
  RESEND_API_KEY: string     // wrangler secret (newsletter)
  HOBBOT_CHAT: Fetcher
  HOBBOT_CUSTODIAN: Service  // CustodianEntrypoint
  HOBBOT_PIPELINE: Service   // PipelineEntrypoint
}
```

No: R2, AI, GEMINI_API_KEY, ANTHROPIC_API_KEY, GITHUB_TOKEN, STYLEFUSION_URL.

## Deploy Order

Always deploy in dependency order (children first, gateway last):

```
hobbot-chat -> hobbot-custodian -> hobbot-pipeline -> hobbot-worker
```

## Build and Deploy

```bash
npm run build        # or: npx wrangler deploy --dry-run
npx wrangler deploy
```

Always build before deploy. Always `--remote` for D1 commands.

## What NOT To Do

- Do not add crons to this worker. All scheduled work runs on child workers.
- Do not add AI provider bindings (R2, AI, GEMINI_API_KEY). Pipeline worker owns those.
- Do not import from `blog/`, `chat/`, `harvesters/`, `transforms/`, `prompts/`, `services/`, `pipeline/agents/`. Those directories were deleted; the code lives in child workers.
- Do not write to GRIMOIRE_DB from this worker (except through grimoire/ingest.ts for atom-level ingest). Use pipeline RPC for knowledge ingest.
- Do not delete shared code from `grimoire/`, `state/`, `providers/`, `config.ts`, `models.ts`, `ledger.ts`. Child workers depend on them via `@shared/*`.
