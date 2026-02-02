// Provider factory and abstraction

import type { AIProvider } from './types';
import { GeminiProvider } from './gemini';

export function getProvider(
  name: string,
  model: string,
  apiKey: string
): AIProvider {
  if (name === 'gemini') {
    return new GeminiProvider(model, apiKey);
  }

  throw new Error(`Unknown provider: ${name}`);
}

// Re-export types for convenience
export type { AIProvider, AIRequest, AIResponse, AIMessage, AIUsage } from './types';
