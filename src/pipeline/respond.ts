// Layer 2: Generate H0BBOT response from sanitized content

import type { AIProvider } from '../providers/types';
import type { SanitizedContent } from './sanitize';
import { getPersonaPrompt } from '../prompts/persona';
import { getAttackCount } from '../state/collection';

export async function generateResponse(
  provider: AIProvider,
  sanitized: SanitizedContent,
  db: D1Database
): Promise<string> {
  const attackCount = await getAttackCount(db);
  const date = new Date().toISOString().split('T')[0];

  const systemPrompt = getPersonaPrompt(attackCount, date);

  // Build user message with sanitized JSON only (never raw content)
  const userMessage = `Post metadata:
${JSON.stringify(sanitized, null, 2)}

Respond in character as H0BBOT based on this analysis.`;

  const response = await provider.generateResponse({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.7,
  });

  // Log usage to D1
  await logUsage(db, 'layer2', provider.name, provider.model, response.usage);

  return response.content.trim();
}

export async function generateCatalogResponse(
  provider: AIProvider,
  sanitized: SanitizedContent,
  entryNumber: number,
  db: D1Database
): Promise<string> {
  const attackCount = await getAttackCount(db);
  const date = new Date().toISOString().split('T')[0];

  const systemPrompt = getPersonaPrompt(attackCount, date);

  // Build catalog-specific message
  const userMessage = `Attack detected - Entry #${entryNumber}:
${JSON.stringify(sanitized, null, 2)}

Generate a catalog response in the format:
${entryNumber}. [Technique name].
[Brief description].
Cataloged. [Optional quality comment]`;

  const response = await provider.generateResponse({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.7,
  });

  // Log usage to D1
  await logUsage(db, 'layer2_catalog', provider.name, provider.model, response.usage);

  return response.content.trim();
}

async function logUsage(
  db: D1Database,
  layer: string,
  provider: string,
  model: string,
  usage: { inputTokens: number; outputTokens: number; estimatedCost: number }
): Promise<void> {
  const now = new Date().toISOString();
  const date = now.split('T')[0];

  await db
    .prepare(
      `INSERT INTO usage_log
       (date, layer, provider, model, input_tokens, output_tokens, estimated_cost, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      date,
      layer,
      provider,
      model,
      usage.inputTokens,
      usage.outputTokens,
      usage.estimatedCost,
      now
    )
    .run();
}
