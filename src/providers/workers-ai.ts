// Workers AI adapter: runs on Cloudflare edge, no external API call needed

import type { AIProvider, AIRequest, AIResponse, AIUsage } from './types'

export class WorkersAIProvider implements AIProvider {
  public name = 'workers-ai'
  public model: string
  private ai: Ai

  constructor(model: string, ai: Ai) {
    this.model = model
    this.ai = ai
  }

  async generateResponse(request: AIRequest): Promise<AIResponse> {
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = []

    for (const msg of request.messages) {
      messages.push({ role: msg.role, content: msg.content })
    }

    const runInput: Record<string, unknown> = {
      messages,
      max_tokens: request.maxTokens ?? 1024,
      temperature: request.temperature ?? 0.2,
    }

    // Disable thinking on Qwen3 chat-template models when budget=0.
    // Qwen3 honors enable_thinking via chat_template_options; other models ignore it.
    if (request.thinkingBudget === 0) {
      runInput.chat_template_options = { enable_thinking: false }
    }

    const result = await this.ai.run(this.model as Parameters<Ai['run']>[0], runInput as never)

    // Workers AI text-generation models return either:
    // - Legacy format: { response: string }
    // - OpenAI-compatible format (Qwen3, etc.): { choices: [{ message: { content: string } }] }
    let content: string
    if (typeof result === 'object' && result !== null) {
      const r = result as Record<string, unknown>
      if ('response' in r && typeof r.response === 'string') {
        content = r.response
      } else if ('choices' in r && Array.isArray(r.choices) && r.choices.length > 0) {
        const choice = r.choices[0] as { message?: { content?: string } }
        content = choice?.message?.content ?? JSON.stringify(result)
      } else {
        content = JSON.stringify(result)
      }
    } else {
      content = JSON.stringify(result)
    }

    // Workers AI doesn't return token counts; estimate for cost tracking
    const inputChars = request.messages.reduce((acc, m) => acc + m.content.length, 0)
    const usage: AIUsage = {
      inputTokens: Math.ceil(inputChars / 4),
      outputTokens: Math.ceil(content.length / 4),
      estimatedCost: 0, // Workers AI: neuron-based, tracked separately
    }

    return { content, usage }
  }
}
