// Dream Glossary: AI-generated glossary drafts + promotion to glossary_entries
// Drafts are staged in glossary_drafts, promoted to glossary_entries
// where the existing maybePostGlossaryEntry pipeline picks them up.

import type { D1Database } from '@cloudflare/workers-types';
import type { AIProvider } from '../providers/types';
import { calculateSimilarity } from '../pipeline/extract-patterns';
import type { PatternSnapshot, ResearchFinding, GlossaryDraft } from './types';

const MIN_OBSERVED_COUNT = 5;
const MAX_CANDIDATES_PER_DREAM = 3;
const TERM_SIMILARITY_THRESHOLD = 0.5;
// AI-generated entries start at 1000 to sort after the 5 seeded entries
const AI_ENTRY_NUMBER_BASE = 1000;

/**
 * Generate glossary drafts from mature, validated patterns.
 * Single layer2 AI call with JSON response.
 */
export async function generateGlossaryDrafts(
  provider: AIProvider,
  db: D1Database,
  patterns: PatternSnapshot[],
  research: ResearchFinding[],
): Promise<{ drafts: GlossaryDraft[]; tokenCost: number }> {
  // Load existing terms for dedup
  const existingTerms = await db.prepare(
    'SELECT term FROM glossary_entries',
  ).all<{ term: string }>();
  const existingDrafts = await db.prepare(
    "SELECT term FROM glossary_drafts WHERE status != 'discarded'",
  ).all<{ term: string }>();

  const allExistingTerms = [
    ...(existingTerms.results ?? []).map(r => r.term),
    ...(existingDrafts.results ?? []).map(r => r.term),
  ];

  // Build research lookup for validation signals
  const researchMap = new Map(research.map(r => [r.pattern_id, r]));

  // Select candidates: mature + validated + not already covered
  const candidates = patterns.filter(p => {
    if (p.observed_count < MIN_OBSERVED_COUNT) return false;

    // Must have confirmed or emerging research signal
    const finding = researchMap.get(p.pattern_id);
    if (!finding || (finding.validation_signal !== 'confirmed' && finding.validation_signal !== 'emerging')) {
      return false;
    }

    // Check similarity against existing terms
    for (const existing of allExistingTerms) {
      if (calculateSimilarity(existing, p.pattern_name) > TERM_SIMILARITY_THRESHOLD) {
        return false;
      }
    }

    return true;
  }).slice(0, MAX_CANDIDATES_PER_DREAM);

  if (candidates.length === 0) {
    console.log('dream_glossary: no candidates qualify');
    return { drafts: [], tokenCost: 0 };
  }

  // Build prompt
  const patternData = candidates.map(p => {
    const finding = researchMap.get(p.pattern_id);
    return {
      pattern_name: p.pattern_name,
      description: p.structural_description,
      category: p.category,
      observations: p.observed_count,
      research: finding ? `${finding.validation_signal}: ${finding.evidence_summary}` : 'no research',
    };
  });

  const existingTermList = allExistingTerms.length > 0
    ? allExistingTerms.join(', ')
    : '(none)';

  const userPrompt = `PATTERNS TO DEFINE:
${JSON.stringify(patternData, null, 2)}

EXISTING GLOSSARY TERMS (do not duplicate):
${existingTermList}

For each pattern, generate a glossary entry. Return JSON:
{
  "entries": [
    {
      "term": "2-4 word term name",
      "definition": "Clear, technical definition. No metaphors, no persona voice. 1-2 sentences.",
      "relevance": "Why this matters practically. 1 sentence.",
      "example": "Concrete example showing the concept in action. 1-2 sentences.",
      "source_pattern": "pattern_name this entry is derived from"
    }
  ]
}

Rules:
- Only generate entries for patterns with enough data to define clearly
- If a pattern is too vague or overlaps with existing terms, skip it
- Return empty entries array if nothing qualifies`;

  const systemPrompt = `You are generating glossary entries for a technical reference on social platform behavioral patterns. Output structured JSON only. No persona voice, no metaphors. Plain analytical language.`;

  try {
    const response = await provider.generateResponse({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.4,
      maxTokens: 1500,
      responseFormat: 'json',
    });

    // Log usage
    const now = new Date().toISOString();
    const date = now.split('T')[0];
    await db.prepare(
      `INSERT INTO usage_log (date, layer, provider, model, input_tokens, output_tokens, estimated_cost, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(date, 'dream_glossary', provider.name, provider.model, response.usage.inputTokens, response.usage.outputTokens, response.usage.estimatedCost, now).run();

    // Parse response
    const parsed = parseGlossaryResponse(response.content, candidates, researchMap);

    // Write drafts to DB
    for (const draft of parsed) {
      await db.prepare(`
        INSERT INTO glossary_drafts (term, definition, relevance, example, source_patterns, confidence)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(
        draft.term,
        draft.definition,
        draft.relevance,
        draft.example,
        JSON.stringify(draft.source_patterns),
        draft.confidence,
      ).run();
    }

    console.log(`dream_glossary: created=${parsed.length}`);
    return { drafts: parsed, tokenCost: response.usage.estimatedCost };
  } catch (error) {
    console.error('dream_glossary: generation failed', error);
    return { drafts: [], tokenCost: 0 };
  }
}

/**
 * Parse and validate glossary AI response.
 */
function parseGlossaryResponse(
  rawContent: string,
  candidates: PatternSnapshot[],
  researchMap: Map<string, ResearchFinding>,
): GlossaryDraft[] {
  try {
    let jsonText = rawContent.trim();

    // Strip markdown fences
    const codeBlockMatch = jsonText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeBlockMatch) {
      jsonText = codeBlockMatch[1].trim();
    }

    const parsed = JSON.parse(jsonText);
    if (!parsed.entries || !Array.isArray(parsed.entries)) return [];

    const drafts: GlossaryDraft[] = [];

    for (const entry of parsed.entries.slice(0, MAX_CANDIDATES_PER_DREAM)) {
      if (!entry.term || !entry.definition || !entry.relevance || !entry.example) continue;

      // Determine confidence from research signal
      const sourcePattern = candidates.find(c =>
        c.pattern_name === entry.source_pattern ||
        calculateSimilarity(c.pattern_name, entry.source_pattern ?? '') > 0.6,
      );

      let confidence = 0.5;
      if (sourcePattern) {
        const finding = researchMap.get(sourcePattern.pattern_id);
        if (finding?.validation_signal === 'confirmed') confidence = 0.8;
        else if (finding?.validation_signal === 'emerging') confidence = 0.6;
      }

      drafts.push({
        term: String(entry.term).slice(0, 100),
        definition: String(entry.definition).slice(0, 500),
        relevance: String(entry.relevance).slice(0, 300),
        example: String(entry.example).slice(0, 500),
        source_patterns: sourcePattern ? [sourcePattern.pattern_id] : [],
        confidence,
      });
    }

    return drafts;
  } catch (error) {
    console.error('dream_glossary: parse failed', error);
    return [];
  }
}

/**
 * Promote high-confidence drafts into glossary_entries.
 * The existing maybePostGlossaryEntry pipeline picks them up
 * via WHERE posted_at IS NULL ORDER BY entry_number ASC.
 */
export async function promoteReadyDrafts(
  db: D1Database,
  minConfidence: number = 0.7,
): Promise<number> {
  const drafts = await db.prepare(`
    SELECT id, term, definition, relevance, example
    FROM glossary_drafts
    WHERE status = 'draft' AND confidence >= ?
    ORDER BY confidence DESC
    LIMIT 2
  `).bind(minConfidence).all<{
    id: number;
    term: string;
    definition: string;
    relevance: string;
    example: string;
  }>();

  if (!drafts.results || drafts.results.length === 0) return 0;

  let promoted = 0;

  for (const draft of drafts.results) {
    try {
      // Get next entry number (AI-generated start at 1000)
      const maxEntry = await db.prepare(
        'SELECT MAX(entry_number) as max_num FROM glossary_entries',
      ).first<{ max_num: number | null }>();

      const nextNumber = Math.max(AI_ENTRY_NUMBER_BASE, (maxEntry?.max_num ?? 0) + 1);

      // Insert into glossary_entries (posted_at = NULL so existing pipeline picks it up)
      await db.prepare(`
        INSERT INTO glossary_entries (term, definition, relevance, example, entry_number)
        VALUES (?, ?, ?, ?, ?)
      `).bind(draft.term, draft.definition, draft.relevance, draft.example, nextNumber).run();

      // Mark draft as promoted
      await db.prepare(`
        UPDATE glossary_drafts SET status = 'promoted', promoted_at = datetime('now') WHERE id = ?
      `).bind(draft.id).run();

      promoted++;
      console.log(`dream_glossary: promoted "${draft.term}" as entry #${nextNumber}`);
    } catch (error) {
      console.error(`dream_glossary: promotion failed for "${draft.term}"`, error);
    }
  }

  return promoted;
}
