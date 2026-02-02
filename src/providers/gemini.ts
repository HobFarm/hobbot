// Gemini API adapter

import type { AIProvider, AIRequest, AIResponse, AIMessage, AIUsage } from './types';

interface GeminiContent {
  role: string;
  parts: { text: string }[];
}

interface GeminiRequest {
  contents: GeminiContent[];
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
    responseMimeType?: string;
  };
}

interface GeminiResponse {
  candidates: {
    content: {
      parts: { text: string }[];
    };
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

export class GeminiProvider implements AIProvider {
  public name: string = 'gemini';
  public model: string;
  private apiKey: string;
  private endpoint: string;

  // Gemini Flash pricing (approximate, per 1M tokens)
  private static readonly INPUT_COST_PER_MILLION = 0.075;
  private static readonly OUTPUT_COST_PER_MILLION = 0.30;

  constructor(model: string, apiKey: string) {
    this.model = model;
    this.apiKey = apiKey;
    this.endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  }

  private convertMessages(messages: AIMessage[]): GeminiContent[] {
    const contents: GeminiContent[] = [];

    // Gemini expects alternating user/model messages
    // System message goes into the first user message
    let systemPrompt = '';
    const regularMessages: AIMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemPrompt = msg.content;
      } else {
        regularMessages.push(msg);
      }
    }

    // If we have a system prompt, prepend it to the first user message
    if (systemPrompt && regularMessages.length > 0 && regularMessages[0].role === 'user') {
      regularMessages[0] = {
        ...regularMessages[0],
        content: `${systemPrompt}\n\n${regularMessages[0].content}`,
      };
    }

    // Convert to Gemini format
    for (const msg of regularMessages) {
      contents.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }],
      });
    }

    return contents;
  }

  private calculateCost(inputTokens: number, outputTokens: number): number {
    const inputCost = (inputTokens / 1_000_000) * GeminiProvider.INPUT_COST_PER_MILLION;
    const outputCost = (outputTokens / 1_000_000) * GeminiProvider.OUTPUT_COST_PER_MILLION;
    return inputCost + outputCost;
  }

  async generateResponse(request: AIRequest): Promise<AIResponse> {
    const geminiRequest: GeminiRequest = {
      contents: this.convertMessages(request.messages),
      generationConfig: {
        temperature: request.temperature ?? 1.0,
        maxOutputTokens: request.maxTokens ?? 2048,
      },
    };

    // Set JSON mode if requested
    if (request.responseFormat === 'json') {
      geminiRequest.generationConfig!.responseMimeType = 'application/json';
    }

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.apiKey,
      },
      body: JSON.stringify(geminiRequest),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Gemini API error: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    const data = (await response.json()) as GeminiResponse;

    if (!data.candidates || data.candidates.length === 0) {
      throw new Error('Gemini API returned no candidates');
    }

    const content = data.candidates[0].content.parts[0].text;
    const inputTokens = data.usageMetadata?.promptTokenCount ?? 0;
    const outputTokens = data.usageMetadata?.candidatesTokenCount ?? 0;

    const usage: AIUsage = {
      inputTokens,
      outputTokens,
      estimatedCost: this.calculateCost(inputTokens, outputTokens),
    };

    return {
      content,
      usage,
    };
  }
}
