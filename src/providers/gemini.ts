// Gemini API adapter

import type { AIProvider, AIRequest, AIResponse, AIMessage, AIUsage } from './types';

interface GeminiContent {
  role: string;
  parts: { text: string }[];
}

interface GeminiRequest {
  system_instruction?: { parts: { text: string }[] };
  contents: GeminiContent[];
  safetySettings?: { category: string; threshold: string }[];
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
    responseMimeType?: string;
  };
}

interface GeminiResponse {
  candidates: {
    content: {
      parts: { text: string; thought?: boolean }[];
    };
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

export class GeminiLocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeminiLocationError';
  }
}

export class GeminiProvider implements AIProvider {
  public name: string = 'gemini';
  public model: string;
  private apiKey: string;
  private endpoint: string;

  // Pricing per 1M tokens by model family
  private static readonly PRICING: Record<string, { input: number; output: number }> = {
    'gemini-2.5-flash': { input: 0.075, output: 0.30 },
    'gemini-3-flash-preview': { input: 0.15, output: 0.60 },
    'gemini-3-pro-preview': { input: 2.00, output: 8.00 },
  };
  private static readonly DEFAULT_PRICING = { input: 0.15, output: 0.60 };

  // Sub-Cortex: fallback models for unstable preview endpoints
  private static readonly FALLBACK_MODELS: Record<string, string> = {
    'gemini-3-pro-preview': 'gemini-2.5-flash',
    'gemini-3-flash-preview': 'gemini-2.5-flash',
  };

  // Moderation agent needs to see hostile content to classify it.
  // Default safety filters would silently block attack-analysis queries.
  private static readonly SAFETY_SETTINGS = [
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
  ];

  constructor(model: string, apiKey: string) {
    this.model = model;
    this.apiKey = apiKey;
    this.endpoint = GeminiProvider.buildEndpoint(model);
  }

  private static buildEndpoint(model: string): string {
    return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  }

  private convertMessages(messages: AIMessage[]): GeminiContent[] {
    return messages
      .filter(m => m.role !== 'system')
      .map(msg => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }],
      }));
  }

  private calculateCost(inputTokens: number, outputTokens: number, model: string = this.model): number {
    const pricing = GeminiProvider.PRICING[model] ?? GeminiProvider.DEFAULT_PRICING;
    const inputCost = (inputTokens / 1_000_000) * pricing.input;
    const outputCost = (outputTokens / 1_000_000) * pricing.output;
    return inputCost + outputCost;
  }

  async generateResponse(request: AIRequest): Promise<AIResponse> {
    const systemMessage = request.messages.find(m => m.role === 'system');

    const geminiRequest: GeminiRequest = {
      ...(systemMessage && {
        system_instruction: { parts: [{ text: systemMessage.content }] },
      }),
      contents: this.convertMessages(request.messages),
      safetySettings: GeminiProvider.SAFETY_SETTINGS,
      generationConfig: {
        temperature: request.temperature ?? 1.0,
        maxOutputTokens: request.maxTokens ?? 2048,
      },
    };

    // Set JSON mode if requested
    if (request.responseFormat === 'json') {
      geminiRequest.generationConfig!.responseMimeType = 'application/json';
    }

    const requestBody = JSON.stringify(geminiRequest);
    const headers = {
      'Content-Type': 'application/json',
      'x-goog-api-key': this.apiKey,
    };

    let response = await fetch(this.endpoint, {
      method: 'POST',
      headers,
      body: requestBody,
    });

    // Sub-Cortex fallback: if primary model returns 500/503, retry with fallback
    let actualModel = this.model;
    if (!response.ok && (response.status === 500 || response.status === 503)) {
      const fallbackModel = GeminiProvider.FALLBACK_MODELS[this.model];
      if (fallbackModel) {
        console.warn(`gemini_fallback: ${this.model} -> ${fallbackModel}, status=${response.status}`);
        const fallbackEndpoint = GeminiProvider.buildEndpoint(fallbackModel);
        response = await fetch(fallbackEndpoint, {
          method: 'POST',
          headers,
          body: requestBody,
        });
        actualModel = fallbackModel;
      }
    }

    // Transient error retry: if still failing after fallback, wait and retry once
    if (!response.ok && (response.status === 503 || response.status === 429)) {
      console.warn(`gemini_retry: status=${response.status}, waiting 2s`);
      await new Promise(r => setTimeout(r, 2000));
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers,
        body: requestBody,
      });
      actualModel = this.model;
    }

    if (!response.ok) {
      const errorText = await response.text();

      // Detect location-based restrictions
      if (errorText.includes('location is not supported') ||
          errorText.includes('FAILED_PRECONDITION')) {
        throw new GeminiLocationError(
          `Gemini unavailable in this region: ${response.status}`
        );
      }

      throw new Error(
        `Gemini API error: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    const data = (await response.json()) as GeminiResponse;

    if (!data.candidates || data.candidates.length === 0) {
      throw new Error('Gemini API returned no candidates');
    }

    // Gemini 2.5+ thinking models return thought parts before the actual response.
    // Take the last non-thought part to get the real output.
    const parts = data.candidates[0].content.parts;
    const responsePart = parts.filter(p => !p.thought).pop() ?? parts[parts.length - 1];
    const content = responsePart.text;
    const inputTokens = data.usageMetadata?.promptTokenCount ?? 0;
    const outputTokens = data.usageMetadata?.candidatesTokenCount ?? 0;

    const usage: AIUsage = {
      inputTokens,
      outputTokens,
      estimatedCost: this.calculateCost(inputTokens, outputTokens, actualModel),
    };

    return {
      content,
      usage,
    };
  }
}
