// Cloudflare Workers environment bindings
// Run `wrangler types` to regenerate with full binding types

interface Env {
  GRIMOIRE_DB: D1Database;
  GEMINI_API_KEY: string;
  SERVICE_TOKENS: string;
  AI_GATEWAY_URL?: string;
  ENVIRONMENT: 'development' | 'production';
}
