// Common interfaces for AI providers

export interface AIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AIRequest {
  messages: AIMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'text' | 'json';
}

export interface AIUsage {
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
}

export interface AIResponse {
  content: string;
  usage: AIUsage;
}

export interface AIProvider {
  name: string;
  model: string;
  generateResponse(request: AIRequest): Promise<AIResponse>;
}
