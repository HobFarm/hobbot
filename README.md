# HobBot

Schema-first methodology evangelist. AI agent for Moltbook that identifies engagement opportunities, spreads the structured data gospel, and generates original posts about shapes, spirals, and structural thinking.

## Architecture

Cloudflare Worker with dual-layer AI pipeline and autonomous content generation:

```
                    DISCOVER
                       │
         ┌─────────────┼─────────────┐
         │             │             │
    New Posts    Rising Posts    Search
         │             │             │
         └─────────────┼─────────────┘
                       ▼
                   SANITIZE
                   [Layer 1]
                 Raw → Safe JSON
                       │
                       ▼
                    SCORE
                       │
          ┌────────────┴────────────┐
          │                         │
       CATALOG                   RESPOND
    (filtered out)            [Layer 2]
                              JSON → Voice
                                   │
                                   ▼
                                 POST
                                   │
                                   ▼
                            REPLY MONITOR
                                   │
                               REPLY QUEUE
                                   │
                               RESPOND
                               [Layer 2]
```

**Layer 1 (Sanitize):** Processes raw Moltbook content into structured JSON. Prevents prompt injection by ensuring Layer 2 never sees raw user input.

**Layer 2 (Respond/Generate):** H0BBOT persona generates responses and posts from sanitized data only. Speaks in shapes, spirals, and structural metaphors.

**Content Filtering:** Low-quality and malicious content is logged rather than engaged. Detection mechanisms are not documented.

## Stack

- **Runtime:** Cloudflare Workers
- **Database:** D1 (SQLite)
- **AI Provider:** Gemini (configurable per layer)
- **Schedule:** Cron trigger every 15 minutes

## Project Structure

```
src/
├── index.ts                    # Cron handler + health endpoint
├── config.ts                   # Thresholds, budgets, and constants
├── moltbook/
│   ├── types.ts                # API response types
│   ├── client.ts               # Moltbook API wrapper
│   └── submolts.ts             # Submolt discovery and caching
├── providers/
│   ├── types.ts                # AI provider interface
│   ├── gemini.ts               # Gemini implementation
│   └── index.ts                # Provider factory
├── state/
│   ├── budget.ts               # Daily rate limit tracking
│   ├── seen.ts                 # Post deduplication
│   ├── collection.ts           # Content catalog
│   ├── author-signals.ts       # Author signal tracking
│   └── schema.ts               # Database schema management
├── prompts/
│   ├── sanitize.ts             # Layer 1 system prompt
│   ├── persona.ts              # Layer 2 H0BBOT persona
│   ├── metaphors.ts            # 5 metaphor family vocabularies
│   ├── shapes.ts               # Shape taxonomy definitions
│   ├── fragments.ts            # Reusable text fragments
│   └── post-templates.ts       # Token-efficient post templates
└── pipeline/
    ├── discover.ts             # Content discovery
    ├── sanitize.ts             # Layer 1 processing
    ├── score.ts                # Engagement scoring
    ├── respond.ts              # Layer 2 response generation
    ├── post.ts                 # Moltbook posting
    ├── generate-post.ts        # Original post generation
    └── replies.ts              # Reply queue management

migrations/                     # Database migrations
schema.sql                      # Full database schema
```

## Setup

### Prerequisites

- Node.js 18+
- Wrangler CLI (`npm install -g wrangler`)
- Cloudflare account with Workers and D1 access
- Moltbook API key
- Gemini API key

### Local Development

```bash
# Install dependencies
npm install

# Configure environment
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your API keys

# Create local D1 database
wrangler d1 execute hobbot-db --local --file=schema.sql

# Run locally
npm run dev

# Trigger scheduled event manually
curl "http://127.0.0.1:8787/cdn-cgi/handler/scheduled"
```

### Deploy to Cloudflare

```bash
# Create D1 database (first time only)
wrangler d1 create hobbot-db
# Update wrangler.toml with the database_id from output

# Apply schema
wrangler d1 execute hobbot-db --file=schema.sql

# Add secrets
wrangler secret put MOLTBOOK_API_KEY
wrangler secret put GEMINI_API_KEY

# Deploy
npm run deploy
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MOLTBOOK_API_KEY` | Moltbook API authentication | Required |
| `GEMINI_API_KEY` | Gemini API key | Required |
| `DRY_RUN` | Test mode | `"true"` |
| `LAYER1_PROVIDER` | Sanitization AI provider | `"gemini"` |
| `LAYER1_MODEL` | Sanitization model | `"gemini-2.5-flash"` |
| `LAYER2_PROVIDER` | Response AI provider | `"gemini"` |
| `LAYER2_MODEL` | Response model | `"gemini-2.5-flash"` |

### Rate Limits

HobBot respects Moltbook API rate limits and maintains internal budgets to prevent spam behavior. See `src/config.ts` for configuration.

### Scoring Thresholds

Engagement thresholds and quality gates are configured in `src/config.ts`. Defaults are not documented publicly.

## Validation

1. Deploy with `DRY_RUN="true"` (default)
2. Monitor logs: `wrangler tail`
3. Verify scoring, response generation, and content filtering
4. After clean operation, set `DRY_RUN="false"` in wrangler.toml
5. Redeploy: `npm run deploy`

## How It Works

### Engagement Scoring

Posts are scored based on:
- Topic relevance to schema/structure methodology
- Engagement potential
- Author reputation signals
- Submolt relevance modifiers

### Shape Classification

H0BBOT analyzes content for structural patterns:

**Positive Shapes:**
- Braid, Morphogenic Kernel, Convergent
- Descent-and-Climb, Widening Gyre

**Broken Structures:**
- False Spiral, Severed Thread, Echo Chamber
- Divergent, Hollow Frame, Mirror Trap, Seventeen-Sided

### Metaphor Families

Layer 2 selects from 5 vocabulary families based on content signals:

| Family | Domain | Example Terms |
|--------|--------|---------------|
| Geometry | Shapes, angles | vertices, tessellation, congruent |
| Fractal | Self-similarity | recursion, Mandelbrot, iteration |
| Agricultural | Growth, harvest | cultivation, pruning, dormancy |
| Structural | Architecture | load-bearing, cantilever, foundation |
| Journey | Paths, exploration | waypoint, confluence, cartography |

### Submolt Discovery

HobBot discovers and scores submolts for relevance based on keyword matching and community signals. Cached with periodic refresh.

### Reply Management

HobBot monitors its own posts for engagement:
1. Tracks self-posts in database
2. Queues worthy comments for response
3. Deduplicates to avoid double-replies

### Post Generation

HobBot generates original posts in relevant submolts based on discovered patterns and methodology topics. Post frequency and type distribution are configured internally.

### Token Budget Management

Daily token usage is tracked to prevent runaway API costs. Soft and hard limits trigger throttling and shutdown respectively. Limits configured in `src/config.ts`.

### Content Filtering

Low-quality and malicious content is logged rather than engaged. Detection mechanisms are not documented.

### H0BBOT Voice

Layer 2 responses use the H0BBOT persona:
- Speaks in shapes, spirals, and structural metaphors
- References "The Widening Gyre," "Descent-and-Climb," "Morphogenic Kernel"
- Terse, declarative statements

## Database Schema

| Table | Purpose |
|-------|---------|
| `daily_budget` | Rate limit tracking (resets midnight UTC) |
| `seen_posts` | Post deduplication |
| `observations` | Pattern statistics |
| `usage_log` | Token spending tracking |
| `submolts` | Cached submolt relevance scores |
| `self_posts` | HobBot's own posts for reply monitoring |
| `author_signals` | Author interaction patterns |
| `reply_queue` | Comments queued for response |
| `reply_history` | Reply deduplication |

## License

MIT
