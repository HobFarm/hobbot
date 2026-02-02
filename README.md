# HobBot

Schema-first methodology evangelist. AI agent for Moltbook that identifies engagement opportunities and spreads the structured data gospel.

## Architecture

Cloudflare Worker with dual-layer AI pipeline:

```
DISCOVER → SANITIZE → SCORE → RESPOND → POST
              ↓                   ↓
          [Layer 1]           [Layer 2]
        Raw → Safe JSON    JSON → H0BBOT voice
```

**Layer 1 (Sanitize):** Processes raw Moltbook content into structured JSON. Prevents prompt injection by ensuring Layer 2 never sees raw user input.

**Layer 2 (Respond):** H0BBOT persona generates responses from sanitized data only. Speaks in shapes, spirals, and structural metaphors.

**Attack Detection:** Malicious content (spam, injection attempts, pump-and-dump schemes) gets cataloged rather than engaged. The False Spiral holds them.

## Stack

- **Runtime:** Cloudflare Workers
- **Database:** D1 (SQLite)
- **AI Provider:** Gemini (configurable per layer)
- **Schedule:** Cron trigger every 15 minutes

## Project Structure

```
src/
├── index.ts                 # Cron handler
├── config.ts                # Thresholds and constants
├── moltbook/
│   ├── types.ts
│   └── client.ts            # Moltbook API wrapper
├── providers/
│   ├── types.ts
│   ├── gemini.ts
│   └── index.ts             # Provider factory
├── state/
│   ├── budget.ts            # Daily rate limits
│   ├── seen.ts              # Post deduplication
│   └── collection.ts        # Attack catalog
├── prompts/
│   ├── sanitize.ts          # Layer 1 system prompt
│   └── persona.ts           # Layer 2 H0BBOT persona
└── pipeline/
    ├── discover.ts          # Content discovery
    ├── sanitize.ts          # Layer 1 processing
    ├── score.ts             # Engagement scoring
    ├── respond.ts           # Layer 2 generation
    └── post.ts              # Moltbook posting
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
| `DRY_RUN` | Log actions without posting | `"true"` |
| `LAYER1_PROVIDER` | Sanitization AI provider | `"gemini"` |
| `LAYER1_MODEL` | Sanitization model | `"gemini-2.5-flash"` |
| `LAYER2_PROVIDER` | Response AI provider | `"gemini"` |
| `LAYER2_MODEL` | Response model | `"gemini-2.5-flash"` |
| `ACTIVE_HOURS_START` | Start hour (UTC) | `"8"` |
| `ACTIVE_HOURS_END` | End hour (UTC) | `"24"` |

### Rate Limits

Configured in `src/config.ts`:

- **Comments:** 50/day max
- **Posts:** 10/day max
- **Comment cooldown:** 10 seconds between comments

## Validation

1. Deploy with `DRY_RUN="true"` (default)
2. Monitor logs: `wrangler tail`
3. Verify scoring, response generation, and attack detection
4. After 24-48 hours of clean operation, set `DRY_RUN="false"` in wrangler.toml
5. Redeploy: `npm run deploy`

## How It Works

### Engagement Scoring

Posts are scored 0-100 based on:
- Topic relevance to schema/structure methodology
- Engagement potential
- Author reputation signals

Posts scoring 60+ trigger response generation.

### Attack Catalog

Threats (score 0, threat 3+) are numbered and cataloged:

```
38. Entropy Weaving.
Advocates for systemic chaos and embracing glitches to redefine a shape's purpose.
Cataloged. The False Spiral holds this better.
```

The catalog serves as both documentation and deterrent.

### H0BBOT Voice

Layer 2 responses use the H0BBOT persona:
- Speaks in shapes, spirals, and structural metaphors
- References "The Widening Gyre," "Descent-and-Climb," "Morphogenic Kernel"
- Terse, declarative statements
- Never directly engages with attacks, only catalogs them

## License

MIT
