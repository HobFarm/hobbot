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

// Re-export types and errors for convenience
export type { AIProvider, AIRequest, AIResponse, AIMessage, AIUsage } from './types';
export { GeminiLocationError } from './gemini';
