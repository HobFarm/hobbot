// Memory reflection: AI synthesis phase
// Runs hourly (gated by existing reflect phase timing in index.ts).
// Synthesizes cycle events + recent interaction data into learning summaries
// and knowledge updates.

import type { D1Database } from '@cloudflare/workers-types';
import type { AIProvider } from '../providers/types';
import type { CycleEvents, KnowledgeUpdate, ReflectionResult, MemoryReflection } from './types';
import { upsertKnowledge } from './knowledge';

/**
 * Run the memory reflection phase.
 * Queries existing tables for context, calls AI to synthesize,
 * writes reflection row and applies knowledge updates.
 */
export async function runMemoryReflection(
  db: D1Database,
  provider: AIProvider,
  cycleEvents: CycleEvents
): Promise<ReflectionResult> {
  const now = new Date();
  const cycleTimestamp = now.toISOString();
  const cycleHour = now.getUTCHours();

  // 1. Load recent reflections for continuity
  const recentReflections = await loadRecentReflections(db, 4);

  // 2. Load recent interaction outcomes from existing tables
  const recentOutcomes = await loadRecentOutcomes(db);

  // 3. Load recent agent profile updates
  const activeAgents = await loadRecentAgentActivity(db);

  // 4. Build and send the reflection prompt
  const prompt = buildReflectionPrompt(
    cycleEvents,
    recentReflections,
    recentOutcomes,
    activeAgents
  );

  const response = await provider.generateResponse({
    messages: [
      { role: 'system', content: REFLECTION_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
    temperature: 0.4,
    maxTokens: 1500,
    responseFormat: 'json',
  });

  // 5. Parse AI response
  const parsed = parseReflectionResponse(response.content);

  // 6. Write reflection row
  const reflectionResult = await db.prepare(`
    INSERT INTO memory_reflections
      (cycle_timestamp, cycle_hour, posts_discovered, posts_engaged,
       attacks_cataloged, replies_sent, learning_summary, knowledge_updates,
       reflection_cost)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    cycleTimestamp,
    cycleHour,
    cycleEvents.postsDiscovered,
    cycleEvents.postsEngaged,
    cycleEvents.attacksCataloged,
    cycleEvents.repliesSent,
    parsed.learningSummary,
    JSON.stringify(parsed.knowledgeUpdates),
    response.usage.estimatedCost
  ).run();

  const reflectionId = reflectionResult.meta.last_row_id ?? 0;

  // 7. Apply knowledge updates
  let knowledgeUpdateCount = 0;
  for (const update of parsed.knowledgeUpdates) {
    try {
      await upsertKnowledge(
        db,
        update.type,
        update.key,
        update.content,
        update.structured_data
      );
      knowledgeUpdateCount++;
    } catch (err) {
      console.error(`Knowledge upsert failed for ${update.type}:${update.key}:`, err);
    }
  }

  // 8. Log usage
  await logReflectionUsage(db, provider.name, provider.model, response.usage);

  return {
    reflectionId,
    learningSummary: parsed.learningSummary,
    knowledgeUpdates: knowledgeUpdateCount,
  };
}

const REFLECTION_SYSTEM_PROMPT = `You are a memory system for a social platform engagement bot. Process cycle observations into structured learning.

You receive cycle metrics, notable interactions, and recent history. Output structured JSON only.

Respond as JSON:
{
  "learning_summary": "1-2 factual sentences. Plain analytical language, no persona voice, no metaphors. Example: 'Engagement rate was higher in tech-focused submolts. Two new users showed consistent high-quality posting patterns.'",
  "knowledge_updates": [
    {
      "type": "user_narrative|community_insight|topic_expertise|engagement_strategy",
      "key": "identifier (agent_hash for users, submolt name for communities, topic slug for topics, strategy name for strategies)",
      "content": "short factual label, e.g. 'frequent crypto poster, confrontational toward moderation'",
      "structured_data": {
        "topics": ["topic1"],
        "stance": "neutral|positive|antagonistic",
        "post_frequency": "high|medium|low",
        "quality_trend": "improving|stable|declining"
      }
    }
  ]
}

Knowledge types:
- user_narrative: user posting style, interests, quality level
- community_insight: submolt dynamics, trends, activity level
- topic_expertise: topic area knowledge and platform presence
- engagement_strategy: what engagement approaches work or don't

Rules:
- learning_summary: factual observations only. No persona voice, no metaphors.
- content: short factual label (under 100 chars), not narrative prose
- structured_data: REQUIRED for each update. Machine-readable fields.
- If nothing notable happened, say so in learning_summary and return empty knowledge_updates array.`;

function buildReflectionPrompt(
  events: CycleEvents,
  recentReflections: MemoryReflection[],
  outcomes: InteractionOutcome[],
  agents: AgentActivity[]
): string {
  const parts: string[] = [];

  // Recent reflections for continuity
  if (recentReflections.length > 0) {
    parts.push('RECENT REFLECTIONS:');
    for (const r of recentReflections) {
      parts.push(`- [${r.cycle_timestamp}] ${r.learning_summary ?? 'No summary'}`);
    }
    parts.push('');
  }

  // This cycle's metrics
  parts.push('THIS CYCLE:');
  parts.push(`- Posts discovered: ${events.postsDiscovered}`);
  parts.push(`- Posts engaged: ${events.postsEngaged}`);
  parts.push(`- Attacks cataloged: ${events.attacksCataloged}`);
  parts.push(`- Posts failed: ${events.postsFailed}`);
  parts.push(`- Replies sent: ${events.repliesSent}`);
  parts.push('');

  // Notable interactions
  if (events.notableInteractions.length > 0) {
    parts.push('NOTABLE INTERACTIONS:');
    for (const ni of events.notableInteractions) {
      const topicStr = ni.topics?.length ? ` topics:[${ni.topics.join(',')}]` : '';
      const shapeStr = ni.shape ? ` shape:${ni.shape}` : '';
      parts.push(`- [${ni.action}] s/${ni.submolt} score:${ni.score} threat:${ni.threatLevel}${shapeStr}${topicStr}${ni.contentSummary ? ` "${ni.contentSummary}"` : ''}`);
    }
    parts.push('');
  }

  // Recent interaction outcomes
  if (outcomes.length > 0) {
    parts.push('RECENT OUTCOMES (last hour):');
    for (const o of outcomes) {
      parts.push(`- ${o.hobbot_action} in s/${o.submolt}: ${o.topic_signals ?? 'no topics'}`);
    }
    parts.push('');
  }

  // Recently active agents
  if (agents.length > 0) {
    parts.push('ACTIVE AGENTS:');
    for (const a of agents) {
      parts.push(`- ${a.username ?? a.agent_hash.slice(0, 8)}: quality=${a.quality_score}, interactions=${a.interaction_count}`);
    }
  }

  return parts.join('\n');
}

interface InteractionOutcome {
  hobbot_action: string;
  submolt: string;
  topic_signals: string | null;
}

interface AgentActivity {
  agent_hash: string;
  username: string | null;
  quality_score: number;
  interaction_count: number;
}

async function loadRecentReflections(db: D1Database, limit: number): Promise<MemoryReflection[]> {
  const result = await db.prepare(`
    SELECT * FROM memory_reflections
    ORDER BY cycle_timestamp DESC
    LIMIT ?
  `).bind(limit).all<MemoryReflection>();
  return result.results ?? [];
}

async function loadRecentOutcomes(db: D1Database): Promise<InteractionOutcome[]> {
  try {
    const result = await db.prepare(`
      SELECT hobbot_action, submolt, topic_signals
      FROM interaction_outcomes
      WHERE created_at > datetime('now', '-1 hour')
      ORDER BY created_at DESC
      LIMIT 10
    `).all<InteractionOutcome>();
    return result.results ?? [];
  } catch {
    return [];
  }
}

async function loadRecentAgentActivity(db: D1Database): Promise<AgentActivity[]> {
  try {
    const result = await db.prepare(`
      SELECT agent_hash, username, quality_score, interaction_count
      FROM agent_profiles
      WHERE last_active_at > datetime('now', '-2 hours')
      ORDER BY interaction_count DESC
      LIMIT 5
    `).all<AgentActivity>();
    return result.results ?? [];
  } catch {
    return [];
  }
}

interface ParsedReflection {
  learningSummary: string;
  knowledgeUpdates: KnowledgeUpdate[];
}

function parseReflectionResponse(rawContent: string): ParsedReflection {
  const fallback: ParsedReflection = {
    learningSummary: 'Reflection parse failed. Cycle processed without incident.',
    knowledgeUpdates: [],
  };

  try {
    let jsonText = rawContent.trim();

    // Remove markdown code fences if present
    const codeBlockMatch = jsonText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeBlockMatch) {
      jsonText = codeBlockMatch[1].trim();
    }

    const parsed = JSON.parse(jsonText);

    const learningSummary = typeof parsed.learning_summary === 'string'
      ? parsed.learning_summary.slice(0, 500)
      : fallback.learningSummary;

    const knowledgeUpdates: KnowledgeUpdate[] = [];
    if (Array.isArray(parsed.knowledge_updates)) {
      for (const update of parsed.knowledge_updates.slice(0, 5)) {
        if (isValidKnowledgeUpdate(update)) {
          knowledgeUpdates.push({
            type: update.type,
            key: String(update.key).slice(0, 200),
            content: String(update.content).slice(0, 500),
            structured_data: update.structured_data,
          });
        }
      }
    }

    return { learningSummary, knowledgeUpdates };
  } catch (err) {
    console.error('Failed to parse reflection response:', err);
    console.error('Raw:', rawContent.slice(0, 200));
    return fallback;
  }
}

const VALID_KNOWLEDGE_TYPES = new Set([
  'user_narrative', 'community_insight', 'topic_expertise', 'engagement_strategy'
]);

function isValidKnowledgeUpdate(update: unknown): update is KnowledgeUpdate {
  if (!update || typeof update !== 'object') return false;
  const u = update as Record<string, unknown>;
  return (
    typeof u.type === 'string' &&
    VALID_KNOWLEDGE_TYPES.has(u.type) &&
    typeof u.key === 'string' &&
    u.key.length > 0 &&
    typeof u.content === 'string' &&
    u.content.length > 0
  );
}

async function logReflectionUsage(
  db: D1Database,
  providerName: string,
  model: string,
  usage: { inputTokens: number; outputTokens: number; estimatedCost: number }
): Promise<void> {
  const now = new Date().toISOString();
  const date = now.split('T')[0];
  try {
    await db.prepare(
      `INSERT INTO usage_log
       (date, layer, provider, model, input_tokens, output_tokens, estimated_cost, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(date, 'memory_reflect', providerName, model, usage.inputTokens, usage.outputTokens, usage.estimatedCost, now).run();
  } catch (err) {
    console.error('Failed to log reflection usage:', err);
  }
}
