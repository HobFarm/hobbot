// Cloudflare Workers environment bindings
// Run `wrangler types` to regenerate with full binding types

interface Env {
  GRIMOIRE_DB: D1Database;
  HOBBOT_DB: D1Database;
  SERVICE_TOKENS: string;
  PROVIDER_HEALTH?: KVNamespace;
  GRIMOIRE: Fetcher;
  ENVIRONMENT: 'development' | 'production';
  RESEND_API_KEY: string;
  HOBBOT_CHAT: Fetcher;
  HOBBOT_CUSTODIAN: Service;
  HOBBOT_PIPELINE: Service;
}
