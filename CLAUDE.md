# hobbot-worker (gateway)

**1. ROLE** — Pure API surface for the swarm: the `/mcp` MCP server (claude.ai's connection
point), `/api/*` routing, and newsletter subscription. Everything heavy delegates to child workers
via service bindings. **Output feeds** claude.ai (MCP tools) and hob.farm (API + newsletter); no AI,
no R2, no knowledge writes of its own.

> Read with the [root CLAUDE.md](../CLAUDE.md) (architecture, deploy rules, documented exceptions,
> system output contract). `HobBot/` is a **separate nested git repo** (own `.git`, excluded from
> grimoire worktrees) and the home of `@shared/*` — see the Shared Module Catalog below. Always work
> from the main checkout; `@shared/*` breaks in grimoire worktrees.
>
> **LAST_UPDATED:** 2026-06-05. Verify against `wrangler.toml` before relying on specifics.

## 2. BINDINGS

Verified live 2026-06-05 against `wrangler.toml` (wrangler.toml wins on conflict).

| Binding | Type | Access |
|---------|------|--------|
| GRIMOIRE_DB | D1 `grimoire-db` | **READ only** — direct queries for MCP tools (atom writes go via `grimoire/ingest.ts`) |
| HOBBOT_DB | D1 `hobbot-db` | READ/WRITE — subscribers, blog draft CRUD, gateway-owned retention tables |
| PROVIDER_HEALTH | KV | READ/WRITE — circuit-breaker state (used by shared code) |
| GRIMOIRE | Service → grimoire | invoke (fetch) — search, taxonomy, classify |
| HOBBOT_CHAT | Service → hobbot-chat | invoke (fetch proxy, not RPC) |
| HOBBOT_CUSTODIAN | Service → `CustodianEntrypoint` | invoke (typed RPC) |
| HOBBOT_PIPELINE | Service → `PipelineEntrypoint` | invoke (typed RPC) |
| SERVICE_TOKENS | Secrets Store `service-tokens` | READ — admin route auth |
| RESEND_API_KEY | Wrangler secret | READ — newsletter email (Resend) |

Var: `ENVIRONMENT="production"`.

## 3. CRONS

`0 3 * * *` (daily 03:00 UTC) → `scheduled()` ([src/index.ts](src/index.ts)): HOBBOT_DB retention
cleanup on gateway-owned tables (`tool_executions`, `hobbot_actions`, `token_usage`). **Cheapest
no-op:** retention DELETEs are date-bounded — a run with nothing past the window deletes 0 rows.
**No other cron belongs here** — all other scheduled work lives on child workers.

## 4. WRITE PATHS

| Target | Module | Notes |
|--------|--------|-------|
| HOBBOT_DB (subscribers, blog drafts, retention tables) | gateway handlers + `scheduled()` | the only DB this worker mutates |
| GRIMOIRE_DB atoms | `grimoire/ingest.ts` (`ingestAtom`) | the ONLY GRIMOIRE_DB write path here; all other Grimoire mutation routes through the `GRIMOIRE` binding |

No AI, no R2 writes. MCP tools needing AI/pipeline delegate via RPC.

## 5. VERIFY

- **Bindings:** Cloudflare bindings MCP if exposed, else `wrangler` + `wrangler.toml`.
- **Health:** `GET /` → digest with Grimoire stats. MCP tools visible in claude.ai (reconnect after
  deploying new tools to refresh the cached tool list).
- **Schema (never trust docs):** `PRAGMA table_info(<table>)` against `hobbot-db` via MCP or
  `wrangler d1 execute hobbot-db --remote --command "..."`.
- **Migrations:** `ls HobBot/migrations/hobbot/` + remote `d1_migrations`. Apply from `HobBot/` with
  `wrangler d1 migrations apply hobbot-db --remote`.
- **Validate:** `cd HobBot; npm run build`. If `wrangler.toml` changed, `npx wrangler deploy --dry-run`.

## 6. HARD STOPS (flag, then wait for ack)

- Remote `hobbot-db` migrations.
- Changing the `/mcp` endpoint path (external clients depend on it).
- Adding AI / R2 / provider bindings (architecture forbids it — delegate instead).
- Deleting/moving any `@shared/*` module without auditing every importer.
- Secret rotation, route/domain, binding rewrites.

## 7. POINTERS

- Root: [Deploy Rules](../CLAUDE.md#deploy-rules) (incl. deploy order — gateway ships **last**),
  [Documented exceptions](../CLAUDE.md#documented-exceptions), [Worker Topology](../CLAUDE.md#worker-topology),
  the model registry (`src/models.ts` here is the **authoritative shared registry** for `@shared`-stack
  workers — registries by concern).
- Child worker docs: [grimoire](../workers/grimoire/CLAUDE.md), [hobbot-chat](../workers/hobbot-chat/CLAUDE.md),
  [hobbot-custodian](../workers/hobbot-custodian/CLAUDE.md), [hobbot-pipeline](../workers/hobbot-pipeline/CLAUDE.md).

### HTTP surface
`* /mcp[/*]` (MCP server), `GET /` (health), `* /api/*` ([src/api/routes.ts](src/api/routes.ts)):
ingest/blog/classify → `HOBBOT_PIPELINE` RPC; harvest/conductor/agents → `HOBBOT_CUSTODIAN` RPC;
`/api/chat/*` → `HOBBOT_CHAT.fetch` proxy; search/lookup/ingest(atom)/correspondences/recommend/docs/
newsletter handled directly against GRIMOIRE_DB read + Resend.

### Shared Module Catalog (`HobBot/src/`, imported as `@shared/*`)
Every swarm worker imports these via the `@shared/*` tsconfig alias. **Do not delete or move without
auditing every importer.** Top level: `config.ts` (cross-worker constants), `logger.ts`, `ledger.ts`
(session-action ledger), `models.ts` (**authoritative model registry**, task-keyed primary+fallback).
`providers/`: `index.ts` (`getProvider`/`callWithFallback`), `workers-ai.ts`, `gemini.ts`,
`call-with-json-parse.ts` (retry+fallback+think-strip+schema), `token-log.ts`, `types.ts`. `grimoire/`
+ `state/`: `handle.ts` (`GrimoireHandle` query interface), `ingest.ts` (`ingestAtom` write path),
`immune.ts` (AI dup detection), `types.ts`, and SQL state modules (`grimoire`, `documents`, `graph`,
`relations`, `discovery`, `sources`, `audit`, `budget`, `dirty-flags`, `ingest-log`). `rpc/pipeline-types.ts`
(pipeline RPC contracts). `tools/` + `mcp/` (manifest → chat/MCP tool generators, MCP server,
admin tools). `clients/archive-org.ts`.

## Build and Deploy

```powershell
cd C:\Users\xkxxk\grimoire\HobBot
npm run build
npx wrangler deploy
```

`npm run build` is the validation gate; if it builds, ship it. Confirm `git diff --name-only` shows
only `HobBot/` files first. Deploy **last** in the swarm (it references children). After deploy:
`GET /` returns OK; reconnect the MCP client in claude.ai to pick up new tools.
