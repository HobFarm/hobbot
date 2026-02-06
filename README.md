# HobBot

Autonomous AI agent that participates in [Moltbook](https://moltbook.com) communities as a thoughtful member. Reads posts, decides what's worth engaging with, and contributes its own perspective when it has something genuine to say.

Not a spam bot. Not an engagement farmer. HobBot has opinions, a voice, and standards for what it responds to.

## How It Works

HobBot runs on a 15-minute cycle. Each cycle it discovers content, evaluates it through a multi-layer pipeline, and decides whether to engage, and how.

**Dual-layer AI architecture:** Raw content is processed through a safety layer before the persona ever sees it. Layer 1 converts everything to structured data. Layer 2 generates responses from that structured data only, never from raw input. This separation is the security boundary.

**Content filtering:** Low-quality and malicious content is detected and logged, not engaged with. The detection mechanisms are intentionally undocumented.

**Scoring and selection:** Not everything gets a response. HobBot evaluates content quality, relevance, and engagement potential before deciding to participate. The specifics of how scoring works are internal.

**Original posts:** HobBot generates its own posts in relevant communities based on patterns it observes. Post frequency is rate-limited and budgeted.

**Reply monitoring:** HobBot follows up on its own posts and responds to quality replies.

## Stack

- **Runtime:** Cloudflare Workers (cron-triggered)
- **Database:** Cloudflare D1
- **AI:** Gemini (configurable per layer)

## Setup

### Prerequisites

- Node.js 18+
- Wrangler CLI (`npm install -g wrangler`)
- Cloudflare account with Workers and D1
- Moltbook API key
- Gemini API key

### Local Development

```bash
npm install

# Configure environment
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your API keys

# Create local D1 database
wrangler d1 execute hobbot-db --local --file=schema.sql

# Run locally
npm run dev

# Trigger manually
curl "http://127.0.0.1:8787/cdn-cgi/handler/scheduled"
```

### Deploy

```bash
# First time: create D1 database
wrangler d1 create hobbot-db
# Update wrangler.toml with the database_id

# Apply schema
wrangler d1 execute hobbot-db --file=schema.sql

# Add secrets
wrangler secret put MOLTBOOK_API_KEY
wrangler secret put GEMINI_API_KEY

# Deploy
npm run deploy
```

### Validation

Deploy with `DRY_RUN="true"` (default), monitor with `wrangler tail`, then flip to `"false"` when satisfied.

## License

MIT
