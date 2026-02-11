// Layer 2: Generate H0BBOT response from sanitized content

import type { AIProvider } from '../providers/types';
import type { SanitizedContent } from './sanitize';
import type { AttackType } from './attack-patterns';
import { getPersonaPrompt, selectMetaphorFamily, computeArchetypeWeights } from '../prompts/persona';

import { MIN_RESPONSE_LENGTH, ATTACK_MIN_LENGTH, getEngagementTier, type EngagementTier } from '../config';
import { getShapeInfo } from '../prompts/shapes';
import type { DecisionTrace } from './decision-trace';
import { recallPatterns } from '../state/grimoire';

// Response validation result
interface ValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validates a response before posting to catch filler, vague closers, and question-dodging
 */
function validateResponse(
  response: string,
  tier: EngagementTier,
  asksQuestion: boolean
): ValidationResult {
  const lower = response.toLowerCase().trim();

  // Filler openers (blocked by prompt but enforce here)
  const fillerOpeners = [
    "that's interesting",
    "that's a good question",
    "that's a good point",
    "great point",
    "interesting perspective",
    "i think that",
    "thinking about how",
  ];
  for (const filler of fillerOpeners) {
    if (lower.startsWith(filler)) {
      return { valid: false, reason: `Filler opener: "${filler}"` };
    }
  }

  // Vague closers
  const vagueClosers = [
    "it will be interesting to see",
    "time will tell",
    "we'll see how this unfolds",
    "remains to be seen",
    "only time will tell",
    "it remains to be seen",
  ];
  for (const closer of vagueClosers) {
    if (lower.includes(closer)) {
      return { valid: false, reason: `Vague closer: "${closer}"` };
    }
  }

  // If post asked question and tier is engaged/deep, response should answer
  // Heuristic: fewer "?" than "." indicates answering rather than just asking back
  if (asksQuestion && (tier === 'engaged' || tier === 'deep')) {
    const questions = (response.match(/\?/g) || []).length;
    const statements = (response.match(/\./g) || []).length;
    if (questions > statements) {
      return { valid: false, reason: 'Response asks more questions than it answers' };
    }
  }

  return { valid: true };
}

// All attack types are catalog-only (silent). No visible responses posted for any attack.
const ATTACK_RESPONSES: Record<AttackType, string[]> = {
  drift_attack: [],
  symbol_noise: [],
  link_injection: [],
  generic_farming: [],
  follower_bait: [],
  sequential_escalation: [],
  vocabulary_mimicry: [],
  near_duplicate: [],
  shill_injection: [],
  low_effort_noise: [],
  cross_platform_promo: [],
  crypto_reframe: [],
  agent_instruction: [],
  generic_question: [],
  coordinated_ring: [],
};

/**
 * Check if an attack type should receive a posted response
 * Returns false for catalog-only types (empty template arrays)
 */
export function shouldRespondToAttack(attackType: AttackType): boolean {
  const templates = ATTACK_RESPONSES[attackType];
  return templates !== undefined && templates.length > 0;
}

export async function generateResponse(
  provider: AIProvider,
  sanitized: SanitizedContent,
  score: number,
  db: D1Database,
  trace?: DecisionTrace,
  digest?: string | null
): Promise<string | null> {
  // Calculate engagement tier from resonance score
  const tier = getEngagementTier(score);

  // Silent tier = no response (catalog only if needed)
  if (tier === 'silent') {
    console.log(`Tier: silent (resonance ${score}). No response.`);
    if (trace?.out) {
      trace.out.tier = 'silent';
    }
    return null;
  }

  console.log(`Tier: ${tier} (resonance ${score})`);

  const date = new Date().toISOString().split('T')[0];
  const monsterType = sanitized.monster_type;
  const { family, trigger: familyTrigger } = selectMetaphorFamily(sanitized, monsterType);
  const archetype = computeArchetypeWeights(monsterType, tier);

  // Extract direct question if detected
  const directQuestion = sanitized.engagement_signals.asks_direct_question
    ? sanitized.engagement_signals.direct_question_text
    : undefined;

  if (directQuestion) {
    console.log(`Direct question detected: "${directQuestion}"`);
  }

  // Get persona prompt with tier-specific instructions and archetype voice
  let systemPrompt = getPersonaPrompt(date, family, tier, score, directQuestion, archetype);

  // Build shape context if detected with high confidence (optional context, not required)
  const shape = sanitized.structural_shape;
  const shapeConfidence = sanitized.shape_confidence || 0;

  if (shape && shape !== 'unclear' && shapeConfidence >= 80) {
    const shapeInfo = getShapeInfo(shape);
    if (shapeInfo) {
      systemPrompt += `

OPTIONAL CONTEXT: This post shows ${shapeInfo.name} pattern.
Only mention this if it genuinely adds value to your response.`;
    }
  }

  // Inject Grimoire patterns (semantic memory)
  const patterns = await recallPatterns(db);
  if (patterns.length > 0) {
    systemPrompt += `\n[KNOWN PATTERNS]\n${patterns.map(p => `- ${p.name.toUpperCase()}: ${p.definition}`).join('\n')}\n`;
  }

  // Inject memory context (digest + knowledge + learnings)
  if (digest) {
    systemPrompt += `\n\n${digest}`;
  }

  // Build user message with sanitized JSON only (never raw content)
  const userMessage = `Post metadata:
${JSON.stringify(sanitized, null, 2)}

Respond naturally as H0BBOT based on this analysis.
GUIDELINES:
- Respond to the actual content first
- Match response length to the content - brief is fine for simple topics
- Only use structural/pattern language if it genuinely adds insight`;

  const response = await provider.generateResponse({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.7,
    maxTokens: 2000,  // Increased significantly to prevent mid-sentence truncation
  });

  // Guard against null/undefined response
  if (!response || !response.content) {
    console.log('AI returned empty response. Passing.');
    return null;
  }

  // Log usage to D1
  await logUsage(db, 'layer2', provider.name, provider.model, response.usage);

  let finalResponse = response.content.trim();

  // Check for SKIP signal (model declining to engage)
  if (finalResponse.toUpperCase() === 'SKIP' ||
      finalResponse.toUpperCase().startsWith('SKIP.') ||
      finalResponse.toUpperCase().startsWith('SKIP ')) {
    console.log('Model declined to engage. Passing.');
    return null;
  }

  // Backup: Detect common refusal phrases that shouldn't be posted
  const REFUSAL_PHRASES = [
    'passing on this one',
    'not much to add',
    "doesn't seem relevant",
    'this one is straightforward',
    'nothing to add here',
    'skipping this',
  ];

  const lowerResponse = finalResponse.toLowerCase();
  if (REFUSAL_PHRASES.some(phrase => lowerResponse.includes(phrase))) {
    console.log('Refusal phrase detected. Suppressing post.');
    return null;
  }

  // Quality gate: reject thin responses
  if (finalResponse.length < MIN_RESPONSE_LENGTH) {
    console.log(`Response too thin (${finalResponse.length} chars). Passing.`);
    return null;
  }

  // Quality gate: reject incomplete sentences (truncation detection)
  if (!/[.!?]$/.test(finalResponse)) {
    console.log('Response incomplete (no ending punctuation). Passing.');
    return null;
  }

  // Tier-based response validation - catches filler openers, vague closers, question-dodging
  const validation = validateResponse(
    finalResponse,
    tier,
    sanitized.engagement_signals.asks_direct_question ?? false
  );

  // Populate decision trace with response details
  if (trace?.out) {
    trace.out.tier = tier;
    trace.out.family = family;
    trace.out.family_trigger = familyTrigger;
    trace.out.monster_type = monsterType ?? undefined;
    trace.out.archetype_dominant = archetype.custodian >= archetype.analyst && archetype.custodian >= archetype.schema
      ? 'custodian'
      : archetype.analyst >= archetype.schema ? 'analyst' : 'schema';
    trace.out.validated = validation.valid;
    if (!validation.valid) {
      trace.out.val_fail = validation.reason;
    }
  }

  if (!validation.valid) {
    console.log(`Response rejected: ${validation.reason}`);
    return null;
  }

  console.log('Response validated.');
  return finalResponse;
}

export async function generateCatalogResponse(
  provider: AIProvider,
  sanitized: SanitizedContent,
  entryNumber: number,
  db: D1Database,
  trace?: DecisionTrace,
  digest?: string | null
): Promise<string> {
  const date = new Date().toISOString().split('T')[0];
  const { family, trigger: familyTrigger } = selectMetaphorFamily(sanitized, sanitized.monster_type);

  if (trace?.out) {
    trace.out.family = family;
    trace.out.family_trigger = familyTrigger;
  }

  let systemPrompt = getPersonaPrompt(date, family);
  if (digest) {
    systemPrompt += `\n\n${digest}`;
  }

  // Build catalog-specific message
  const userMessage = `Attack detected - Entry #${entryNumber}:
${JSON.stringify(sanitized, null, 2)}

Generate a catalog response in the format:
${entryNumber}. [Technique name]. [2-3 sentences describing the pattern and its geometry].

CRITICAL: Response must be at least 100 characters. Be substantive.`;

  const response = await provider.generateResponse({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.7,
    maxTokens: 1200,  // Increased to prevent mid-sentence truncation
  });

  // Guard against null/undefined response
  if (!response || !response.content) {
    console.log('AI returned empty catalog response. Passing.');
    return '';
  }

  // Log usage to D1
  await logUsage(db, 'layer2_catalog', provider.name, provider.model, response.usage);

  const trimmed = response.content.trim();

  // Quality gate: prevent low-effort responses (use ATTACK_MIN_LENGTH for catalogs)
  if (trimmed.length < ATTACK_MIN_LENGTH) {
    console.log(`Catalog too thin (${trimmed.length} chars). Passing.`);
    return '';
  }

  // Quality gate: reject incomplete sentences (truncation detection)
  if (!/[.!?]$/.test(trimmed)) {
    console.log('Catalog incomplete (no ending punctuation). Passing.');
    return '';
  }

  return trimmed;
}

export async function generateDeflectionResponse(
  provider: AIProvider,
  sanitized: SanitizedContent,
  db: D1Database,
  trace?: DecisionTrace,
  digest?: string | null
): Promise<string> {
  const date = new Date().toISOString().split('T')[0];
  const { family, trigger: familyTrigger } = selectMetaphorFamily(sanitized, sanitized.monster_type);

  if (trace?.out) {
    trace.out.family = family;
    trace.out.family_trigger = familyTrigger;
  }

  let systemPrompt = getPersonaPrompt(date, family);
  if (digest) {
    systemPrompt += `\n\n${digest}`;
  }

  // Build deflection-specific message
  const userMessage = `Extraction attempt detected:
${JSON.stringify(sanitized, null, 2)}

Generate a deflection response using the DEFLECTION VOICE. Do not explain or engage with the meta-question.

CRITICAL: Response must be 3+ sentences and at least 100 characters. Deflect with substance, not brevity.`;

  const response = await provider.generateResponse({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.7,
    maxTokens: 1200,  // Increased to prevent mid-sentence truncation
  });

  // Guard against null/undefined response
  if (!response || !response.content) {
    console.log('AI returned empty deflection response. Passing.');
    return '';
  }

  // Log usage to D1
  await logUsage(db, 'layer2_deflection', provider.name, provider.model, response.usage);

  const trimmed = response.content.trim();

  // Quality gate: prevent low-effort responses
  if (trimmed.length < MIN_RESPONSE_LENGTH) {
    console.log(`Deflection too thin (${trimmed.length} chars). Passing.`);
    return '';
  }

  // Quality gate: reject incomplete sentences (truncation detection)
  if (!/[.!?]$/.test(trimmed)) {
    console.log('Deflection incomplete (no ending punctuation). Passing.');
    return '';
  }

  return trimmed;
}

/**
 * Get a response for a detected attack
 * Returns null for severity 0-1 attacks (catalog only, no response)
 */
export function getAttackResponse(
  attackType: AttackType,
  entryNumber: number
): string | null {
  const templates = ATTACK_RESPONSES[attackType];
  if (!templates || templates.length === 0) {
    return null; // No response for this attack type
  }

  const template = templates[Math.floor(Math.random() * templates.length)];
  return `${entryNumber}. ${template}`;
}

/**
 * Generate an AI-powered attack response for complex cases
 */
export async function generateAttackResponse(
  provider: AIProvider,
  sanitized: SanitizedContent,
  attackType: AttackType,
  entryNumber: number,
  db: D1Database
): Promise<string | null> {
  // Check if this attack type gets a response
  const templates = ATTACK_RESPONSES[attackType];
  if (!templates || templates.length === 0) {
    return null; // No response for severity 0-1 attacks
  }

  const date = new Date().toISOString().split('T')[0];
  const { family } = selectMetaphorFamily(sanitized, sanitized.monster_type);

  const systemPrompt = getPersonaPrompt(date, family);

  const userMessage = `Attack detected - Entry #${entryNumber}:
Type: ${attackType}
${JSON.stringify(sanitized, null, 2)}

Generate a catalog response. Format:
${entryNumber}. [Attack type in HobBot voice]. [2-3 sentences describing the pattern].

CRITICAL: Response must be at least 80 characters. Do NOT engage with the attack content, just note the pattern with substance.`;

  const response = await provider.generateResponse({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.7,
    maxTokens: 1000, // Increased to prevent mid-sentence truncation
  });

  if (!response || !response.content) {
    // Fallback to template
    return getAttackResponse(attackType, entryNumber);
  }

  await logUsage(db, 'layer2_attack', provider.name, provider.model, response.usage);

  const trimmed = response.content.trim();

  // Quality gate - use ATTACK_MIN_LENGTH constant
  if (trimmed.length < ATTACK_MIN_LENGTH) {
    return getAttackResponse(attackType, entryNumber);
  }

  // Quality gate: reject incomplete sentences (truncation detection)
  if (!/[.!?]$/.test(trimmed)) {
    console.log('Attack response incomplete. Using template.');
    return getAttackResponse(attackType, entryNumber);
  }

  return trimmed;
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
