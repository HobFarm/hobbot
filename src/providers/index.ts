// Provider factory and abstraction

import type { AIProvider } from './types';
import { GeminiProvider, GeminiLocationError } from './gemini';
import { WorkersAIProvider } from './workers-ai';

export function getProvider(
  name: string,
  model: string,
  apiKeyOrAi: string | Ai
): AIProvider {
  if (name === 'gemini') {
    return new GeminiProvider(model, apiKeyOrAi as string);
  }

  if (name === 'workers-ai') {
    return new WorkersAIProvider(model, apiKeyOrAi as Ai);
  }

  throw new Error(`Unknown provider: ${name}`);
}

// --- Secrets Store key resolution ---
// Handles both plain strings and Cloudflare Secrets Store bindings (Fetcher with .get()).
// Previously duplicated in 7 files across chat, custodian, and pipeline workers.

export async function resolveApiKey(key: string | { get: () => Promise<string> }): Promise<string> {
  if (typeof key === 'string') return key
  if (key && typeof key === 'object' && 'get' in key) return await key.get()
  return String(key)
}

// Re-export types and errors for convenience
export type { AIProvider, AIRequest, AIResponse, AIMessage, AIUsage } from './types';
export { GeminiLocationError } from './gemini';
export { createTokenLogger } from './token-log';
export type { TokenUsageReport } from './call-with-json-parse';
