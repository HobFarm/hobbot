// Lucid Dream: main orchestrator
// Runs once per 24h at 2 AM UTC. Five phases:
// 1. Load data (D1 reads)
// 2. Research + Community Vibe + DM Feedback (Moltbook API, no AI)
// 3. Evolve (D1 writes, no AI)
// 4. Synthesize (layer2 AI call)
// 5. Crystallize (D1 writes, knowledge updates, glossary promotion)

import type { D1Database } from '@cloudflare/workers-types';
import type { AIProvider } from '../providers/types';
import type { MoltbookClient } from '../moltbook/client';
import { RateLimitError } from '../moltbook/client';
import type { KnowledgeUpdate } from '../memory/types';
import { upsertKnowledge } from '../memory/knowledge';
import { researchPatterns, persistResearchFindings, getResearchTrends, getCommunityVibe } from './researcher';
import { snapshotPatterns } from './evolve';
import { generateGlossaryDrafts, promoteReadyDrafts } from './glossary';
import type {
  PatternSnapshot,
  PatternEvolution,
  ResearchFinding,
  DreamSynthesis,
  DreamResult,
  PatternRefinement,
  CommunityVibe,
  OwnPostPerformance,
  DMFeedbackSignal,
} from './types';

// ============================================
// Dream Run Tracking
// ============================================

/**
 * Get the completion timestamp of the last successful dream run.
 * Used by the cron gate to enforce 20h cooldown.
 */
export async function getLastDreamRun(db: D1Database): Promise<string | null> {
  const row = await db.prepare(`
    SELECT completed_at FROM dream_runs
    WHERE status = 'completed'
    ORDER BY completed_at DESC
    LIMIT 1
  `).first<{ completed_at: string }>();
  return row?.completed_at ?? null;
}

async function startDreamRun(db: D1Database): Promise<number> {
  const result = await db.prepare(`
    INSERT INTO dream_runs (started_at) VALUES (datetime('now'))
  `).run();
  return result.meta.last_row_id ?? 0;
}

async function completeDreamRun(
  db: D1Database,
  dreamId: number,
  stats: {
    patternsEvolved: number;
    researchFindings: number;
    glossaryDraftsCreated: number;
    glossaryDraftsPromoted: number;
    synthesisSummary: string;
    tokenCost: number;
    dmSignalsFound: number;
    communityVibe: string | null;
  },
): Promise<void> {
  await db.prepare(`
    UPDATE dream_runs SET
      completed_at = datetime('now'),
      status = 'completed',
      patterns_evolved = ?,
      research_findings = ?,
      glossary_drafts_created = ?,
      glossary_drafts_promoted = ?,
      synthesis_summary = ?,
      token_cost = ?,
      dm_signals_found = ?,
      community_vibe = ?
    WHERE id = ?
  `).bind(
    stats.patternsEvolved,
    stats.researchFindings,
    stats.glossaryDraftsCreated,
    stats.glossaryDraftsPromoted,
    stats.synthesisSummary,
    stats.tokenCost,
    stats.dmSignalsFound,
    stats.communityVibe,
    dreamId,
  ).run();
}

async function failDreamRun(db: D1Database, dreamId: number, error: string): Promise<void> {
  await db.prepare(`
    UPDATE dream_runs SET
      completed_at = datetime('now'),
      status = 'failed',
      error = ?
    WHERE id = ?
  `).bind(error.slice(0, 500), dreamId).run();
}

// ============================================
// Data Loading (Phase 1)
// ============================================

async function loadActivePatterns(db: D1Database): Promise<PatternSnapshot[]> {
  const result = await db.prepare(`
    SELECT pattern_id, pattern_name, category, structural_description,
           geometric_metaphor, observed_count, generation_seeds,
           first_seen_at, last_seen_at, active
    FROM hobbot_patterns
    WHERE active = 1
    ORDER BY observed_count DESC
  `).all<PatternSnapshot>();

  return (result.results ?? []).map(p => ({
    ...p,
    generation_seeds: typeof p.generation_seeds === 'string'
      ? JSON.parse(p.generation_seeds)
      : (p.generation_seeds ?? []),
  }));
}

interface AttackSummary {
  geometry: string;
  count: number;
}

async function loadRecentAttacks(db: D1Database): Promise<AttackSummary[]> {
  const result = await db.prepare(`
    SELECT geometry, COUNT(*) as count
    FROM attack_collection
    WHERE timestamp > datetime('now', '-24 hours')
    GROUP BY geometry
    ORDER BY count DESC
    LIMIT 10
  `).all<AttackSummary>();
  return result.results ?? [];
}

interface KnowledgeEntry {
  knowledge_type: string;
  knowledge_key: string;
  content: string;
  confidence: number;
}

async function loadHighConfidenceKnowledge(db: D1Database): Promise<KnowledgeEntry[]> {
  const result = await db.prepare(`
    SELECT knowledge_type, knowledge_key, content, confidence
    FROM memory_knowledge
    WHERE confidence >= 0.4
    ORDER BY confidence DESC
    LIMIT 20
  `).all<KnowledgeEntry>();
  return result.results ?? [];
}

interface ReflectionSummary {
  cycle_timestamp: string;
  learning_summary: string | null;
}

async function loadRecentReflections(db: D1Database): Promise<ReflectionSummary[]> {
  const result = await db.prepare(`
    SELECT cycle_timestamp, learning_summary
    FROM memory_reflections
    WHERE created_at > datetime('now', '-24 hours')
    ORDER BY cycle_timestamp DESC
    LIMIT 10
  `).all<ReflectionSummary>();
  return result.results ?? [];
}

async function loadOwnPostPerformance(db: D1Database): Promise<OwnPostPerformance[]> {
  const result = await db.prepare(`
    SELECT post_id, title, submolt, comment_count, created_at
    FROM own_posts
    WHERE created_at > datetime('now', '-72 hours')
    ORDER BY comment_count DESC
    LIMIT 10
  `).all<{
    post_id: string;
    title: string;
    submolt: string;
    comment_count: number;
    created_at: string;
  }>();

  return (result.results ?? []).map(r => ({
    postId: r.post_id,
    title: r.title,
    submolt: r.submolt,
    commentCount: r.comment_count,
    createdAt: r.created_at,
  }));
}

// ============================================
// DM Feedback Scanning (Phase 2c)
// ============================================

const POSITIVE_SIGNALS = ['good bot', 'thanks', 'helpful', 'nice work', 'great', 'well done', 'love it', 'appreciate'];
const NEGATIVE_SIGNALS = ['spam', 'stop', 'bad bot', 'shut up', 'annoying', 'block', 'go away', 'unwanted'];

async function scanDMFeedback(
  client: MoltbookClient,
): Promise<DMFeedbackSignal[]> {
  const signals: DMFeedbackSignal[] = [];

  try {
    const conversations = await client.getConversations();

    // Only scan conversations with recent unread activity, cap at 5
    const recentConvos = conversations
      .filter(c => c.unread_count > 0)
      .slice(0, 5);

    for (const convo of recentConvos) {
      try {
        const messages = await client.getConversation(convo.id);

        // Only look at messages from the last 24h, not from H0BBOT
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const recentMessages = messages.filter(m =>
          m.created_at > oneDayAgo && m.from.toLowerCase() !== 'h0bbot',
        );

        for (const msg of recentMessages) {
          const lower = msg.content.toLowerCase();

          const isPositive = POSITIVE_SIGNALS.some(s => lower.includes(s));
          const isNegative = NEGATIVE_SIGNALS.some(s => lower.includes(s));

          if (isPositive || isNegative) {
            signals.push({
              conversationId: convo.id,
              participant: convo.participant,
              signalType: isNegative ? 'negative' : 'positive',
              messageSummary: msg.content.slice(0, 200),
            });
          }
        }
      } catch (error) {
        if (error instanceof RateLimitError) {
          console.log('dream_dm: rate_limited, returning partial signals');
          break;
        }
        console.error(`dream_dm: convo ${convo.id} failed`, error);
      }
    }
  } catch (error) {
    if (error instanceof RateLimitError) {
      console.log('dream_dm: rate_limited on conversations list');
    } else {
      console.error('dream_dm: failed', error);
    }
  }

  return signals;
}

async function persistDMSignals(
  db: D1Database,
  dreamRunId: number,
  signals: DMFeedbackSignal[],
): Promise<void> {
  for (const s of signals) {
    await db.prepare(`
      INSERT INTO dream_dm_signals
        (dream_run_id, conversation_id, participant, signal_type, message_summary)
      VALUES (?, ?, ?, ?, ?)
    `).bind(dreamRunId, s.conversationId, s.participant, s.signalType, s.messageSummary).run();
  }
}

async function applyDMSignalsToKnowledge(
  db: D1Database,
  signals: DMFeedbackSignal[],
): Promise<number> {
  let applied = 0;

  for (const signal of signals) {
    if (signal.signalType === 'positive') {
      // Bump confidence on recent engagement_strategy entries (evidenced in last 7d)
      const result = await db.prepare(`
        UPDATE memory_knowledge
        SET confidence = MIN(1.0, confidence + 0.05),
            last_evidence_at = datetime('now')
        WHERE knowledge_type = 'engagement_strategy'
          AND confidence > 0
          AND last_evidence_at > datetime('now', '-7 days')
      `).run();
      applied += result.meta.changes ?? 0;
    }

    if (signal.signalType === 'negative') {
      // Decrease confidence on recent engagement_strategy entries
      const result = await db.prepare(`
        UPDATE memory_knowledge
        SET confidence = MAX(0.1, confidence - 0.05),
            last_updated_at = datetime('now')
        WHERE knowledge_type = 'engagement_strategy'
          AND confidence > 0.1
          AND last_evidence_at > datetime('now', '-7 days')
      `).run();
      applied += result.meta.changes ?? 0;
    }
  }

  return applied;
}

// ============================================
// Synthesis (Phase 4)
// ============================================

const SYNTHESIS_SYSTEM_PROMPT = `You are a meta-analytical system processing 24 hours of behavioral pattern data from a social platform.
Your task: synthesize patterns, external validation, and interaction data into actionable intelligence.

Output structured JSON only. No persona voice, no metaphors. Plain analytical language.

Respond as JSON:
{
  "synthesis_summary": "3-5 sentences analyzing the 24h landscape. What changed? What trends are accelerating? What surprised?",
  "knowledge_updates": [
    {
      "type": "user_narrative|community_insight|topic_expertise|engagement_strategy",
      "key": "identifier",
      "content": "short factual label (under 100 chars)",
      "structured_data": { "relevant_fields": "here" }
    }
  ],
  "pattern_refinements": [
    {
      "pattern_id": "id",
      "refined_description": "improved structural description",
      "reasoning": "why this refinement is needed"
    }
  ]
}

Rules:
- synthesis_summary: factual, analytical. No persona voice.
- knowledge_updates: only genuinely NEW insights not already in the knowledge base. Empty array if nothing new.
- pattern_refinements: only for patterns where research findings reveal new context or contradictions. Empty array if none need refinement.`;

function buildSynthesisPrompt(
  patterns: PatternSnapshot[],
  evolutions: PatternEvolution[],
  research: ResearchFinding[],
  researchTrends: Map<string, Array<{ validation_signal: string; created_at: string }>>,
  attacks: AttackSummary[],
  knowledge: KnowledgeEntry[],
  reflections: ReflectionSummary[],
  digest: string | null,
  ownPosts: OwnPostPerformance[],
  communityVibe: CommunityVibe | null,
  dmSignals: DMFeedbackSignal[],
): string {
  const parts: string[] = [];

  parts.push(`ACTIVE PATTERNS (${patterns.length}):`);
  for (const p of patterns.slice(0, 15)) {
    parts.push(`- ${p.pattern_name} [${p.category}] obs:${p.observed_count} "${p.structural_description.slice(0, 120)}"`);
  }
  parts.push('');

  if (evolutions.length > 0) {
    parts.push(`PATTERN EVOLUTION (${evolutions.length} changes):`);
    for (const e of evolutions) {
      parts.push(`- ${e.pattern_name}: ${e.change_summary}`);
    }
    parts.push('');
  }

  if (research.length > 0) {
    parts.push(`EXTERNAL VALIDATION (${research.length} searches):`);
    for (const r of research) {
      let line = `- ${r.pattern_name}: ${r.validation_signal} (${r.evidence_summary})`;
      // Append trend trajectory if available
      const trend = researchTrends.get(r.pattern_id);
      if (trend && trend.length > 1) {
        const trajectory = trend.map(t => t.validation_signal).reverse().join(' -> ');
        line += ` [trend: ${trajectory}]`;
      }
      parts.push(line);
    }
    parts.push('');
  }

  if (attacks.length > 0) {
    parts.push('ATTACK LANDSCAPE (24h):');
    for (const a of attacks) {
      parts.push(`- ${a.geometry}: ${a.count} occurrences`);
    }
    parts.push('');
  }

  if (reflections.length > 0) {
    parts.push('RECENT LEARNINGS:');
    for (const r of reflections) {
      if (r.learning_summary) {
        parts.push(`- [${r.cycle_timestamp}] ${r.learning_summary.slice(0, 150)}`);
      }
    }
    parts.push('');
  }

  if (knowledge.length > 0) {
    parts.push('CURRENT KNOWLEDGE BASE:');
    for (const k of knowledge) {
      parts.push(`- [${k.knowledge_type}] ${k.knowledge_key} (conf:${k.confidence.toFixed(2)}): ${k.content.slice(0, 100)}`);
    }
    parts.push('');
  }

  if (digest) {
    parts.push('CURRENT DIGEST:');
    parts.push(digest.slice(0, 1500));
    parts.push('');
  }

  if (communityVibe) {
    parts.push('COMMUNITY PULSE (hot feed snapshot):');
    parts.push(communityVibe.vibeDescription);
    if (communityVibe.topTopics.length > 0) {
      parts.push(`Trending topics: ${communityVibe.topTopics.join(', ')}`);
    }
    parts.push('');
  }

  if (ownPosts.length > 0) {
    parts.push('OWN POST PERFORMANCE (last 72h):');
    for (const p of ownPosts) {
      parts.push(`- "${p.title}" [${p.submolt}] comments:${p.commentCount} posted:${p.createdAt}`);
    }
    parts.push('');
  }

  if (dmSignals.length > 0) {
    parts.push('DM FEEDBACK SIGNALS:');
    for (const s of dmSignals) {
      parts.push(`- ${s.participant}: ${s.signalType} "${s.messageSummary.slice(0, 100)}"`);
    }
    parts.push('');
  }

  return parts.join('\n');
}

function parseSynthesisResponse(rawContent: string): DreamSynthesis {
  const fallback: DreamSynthesis = {
    synthesis_summary: 'Dream synthesis parse failed.',
    knowledge_updates: [],
    pattern_refinements: [],
  };

  try {
    let jsonText = rawContent.trim();

    // Strip markdown fences
    const codeBlockMatch = jsonText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeBlockMatch) {
      jsonText = codeBlockMatch[1].trim();
    }

    const parsed = JSON.parse(jsonText);

    const validKnowledgeTypes = new Set([
      'user_narrative', 'community_insight', 'topic_expertise', 'engagement_strategy',
    ]);

    // Validate knowledge updates
    const knowledgeUpdates: KnowledgeUpdate[] = [];
    if (Array.isArray(parsed.knowledge_updates)) {
      for (const u of parsed.knowledge_updates.slice(0, 5)) {
        if (u && typeof u.type === 'string' && validKnowledgeTypes.has(u.type) &&
            typeof u.key === 'string' && u.key.length > 0 &&
            typeof u.content === 'string' && u.content.length > 0) {
          knowledgeUpdates.push({
            type: u.type,
            key: String(u.key).slice(0, 200),
            content: String(u.content).slice(0, 500),
            structured_data: u.structured_data,
          });
        }
      }
    }

    // Validate pattern refinements
    const patternRefinements: PatternRefinement[] = [];
    if (Array.isArray(parsed.pattern_refinements)) {
      for (const r of parsed.pattern_refinements.slice(0, 5)) {
        if (r && typeof r.pattern_id === 'string' && typeof r.refined_description === 'string') {
          patternRefinements.push({
            pattern_id: r.pattern_id,
            refined_description: String(r.refined_description).slice(0, 500),
            reasoning: String(r.reasoning ?? '').slice(0, 300),
          });
        }
      }
    }

    return {
      synthesis_summary: typeof parsed.synthesis_summary === 'string'
        ? parsed.synthesis_summary.slice(0, 1000)
        : fallback.synthesis_summary,
      knowledge_updates: knowledgeUpdates,
      pattern_refinements: patternRefinements,
    };
  } catch (error) {
    console.error('dream_synthesis: parse failed', error);
    console.error('Raw:', rawContent.slice(0, 200));
    return fallback;
  }
}

// ============================================
// Crystallize (Phase 5)
// ============================================

async function applyPatternRefinements(
  db: D1Database,
  refinements: PatternRefinement[],
): Promise<number> {
  let applied = 0;

  for (const ref of refinements) {
    try {
      const result = await db.prepare(`
        UPDATE hobbot_patterns
        SET structural_description = ?,
            last_seen_at = datetime('now')
        WHERE pattern_id = ? AND active = 1
      `).bind(ref.refined_description, ref.pattern_id).run();

      if (result.meta?.changes && result.meta.changes > 0) {
        applied++;
        console.log(`dream_refine: pattern=${ref.pattern_id}, reason="${ref.reasoning.slice(0, 80)}"`);
      }
    } catch (error) {
      console.error(`dream_refine: failed for ${ref.pattern_id}`, error);
    }
  }

  return applied;
}

// ============================================
// Main Orchestrator
// ============================================

export async function runLucidDream(
  db: D1Database,
  layer2Provider: AIProvider,
  moltbookClient: MoltbookClient,
): Promise<DreamResult> {
  const dreamId = await startDreamRun(db);
  let totalTokenCost = 0;

  try {
    // Phase 1: Load data
    console.log('dream[1/5]: loading data');
    const [patterns, attacks, knowledge, reflections, ownPosts] = await Promise.all([
      loadActivePatterns(db),
      loadRecentAttacks(db),
      loadHighConfidenceKnowledge(db),
      loadRecentReflections(db),
      loadOwnPostPerformance(db),
    ]);

    // Load digest separately (simple single-row query)
    let digest: string | null = null;
    try {
      const row = await db.prepare(
        'SELECT content FROM hobbot_digest WHERE id = 1',
      ).first<{ content: string }>();
      digest = row?.content ?? null;
    } catch {
      // Non-critical
    }

    console.log(`dream[1/5]: patterns=${patterns.length}, attacks=${attacks.length}, knowledge=${knowledge.length}, reflections=${reflections.length}, own_posts=${ownPosts.length}`);

    if (patterns.length === 0) {
      console.log('dream: no active patterns, nothing to synthesize');
      await completeDreamRun(db, dreamId, {
        patternsEvolved: 0,
        researchFindings: 0,
        glossaryDraftsCreated: 0,
        glossaryDraftsPromoted: 0,
        synthesisSummary: 'No active patterns to analyze.',
        tokenCost: 0,
        dmSignalsFound: 0,
        communityVibe: null,
      });
      return {
        dreamId,
        patternsEvolved: 0,
        researchFindings: 0,
        glossaryDraftsCreated: 0,
        glossaryDraftsPromoted: 0,
        synthesisSummary: 'No active patterns to analyze.',
        tokenCost: 0,
        needsDigestRebuild: false,
        dmSignalsFound: 0,
        communityVibe: null,
      };
    }

    // Phase 2a: Research (Moltbook search, no AI)
    console.log('dream[2/5]: researching patterns');
    let research: ResearchFinding[] = [];
    try {
      research = await researchPatterns(moltbookClient, patterns, 5);
    } catch (error) {
      console.error('dream[2/5]: research failed, continuing without', error);
    }
    console.log(`dream[2/5]: findings=${research.length}`);

    // Persist research findings for trend analysis
    if (research.length > 0) {
      try {
        await persistResearchFindings(db, dreamId, research);
      } catch (error) {
        console.error('dream[2/5]: research_persist_failed', error);
      }
    }

    // Load research trends for synthesis context (last 3 signals per researched pattern)
    const researchTrends = new Map<string, Array<{ validation_signal: string; created_at: string }>>();
    for (const finding of research) {
      try {
        const trends = await getResearchTrends(db, finding.pattern_id, 3);
        if (trends.length > 1) {
          researchTrends.set(finding.pattern_id, trends);
        }
      } catch {
        // Non-critical
      }
    }

    // Phase 2b: Community Vibe (1 Moltbook API call)
    let communityVibe: CommunityVibe | null = null;
    try {
      communityVibe = await getCommunityVibe(moltbookClient);
      if (communityVibe) {
        console.log(`dream[2/5]: vibe_topics=${communityVibe.topTopics.join(', ')}`);
      }
    } catch (error) {
      console.error('dream[2/5]: vibe_failed', error);
    }

    // Phase 2c: DM Feedback Signals
    let dmSignals: DMFeedbackSignal[] = [];
    try {
      dmSignals = await scanDMFeedback(moltbookClient);
      if (dmSignals.length > 0) {
        await persistDMSignals(db, dreamId, dmSignals);
        const knowledgeAdjusted = await applyDMSignalsToKnowledge(db, dmSignals);
        console.log(`dream[2/5]: dm_signals=${dmSignals.length}, knowledge_adjusted=${knowledgeAdjusted}`);
      }
    } catch (error) {
      console.error('dream[2/5]: dm_scan_failed', error);
    }

    // Phase 3: Evolve (D1 writes, no AI)
    console.log('dream[3/5]: evolving patterns');
    let evolutions: PatternEvolution[] = [];
    try {
      evolutions = await snapshotPatterns(db, patterns);
    } catch (error) {
      console.error('dream[3/5]: evolution failed, continuing without', error);
    }
    console.log(`dream[3/5]: evolved=${evolutions.length}`);

    // Phase 4: Synthesize (layer2 AI call)
    console.log('dream[4/5]: synthesizing');
    const prompt = buildSynthesisPrompt(
      patterns, evolutions, research, researchTrends,
      attacks, knowledge, reflections, digest,
      ownPosts, communityVibe, dmSignals,
    );

    const response = await layer2Provider.generateResponse({
      messages: [
        { role: 'system', content: SYNTHESIS_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: 0.5,
      maxTokens: 2000,
      responseFormat: 'json',
    });

    totalTokenCost += response.usage.estimatedCost;

    // Log usage
    const now = new Date().toISOString();
    const date = now.split('T')[0];
    await db.prepare(
      `INSERT INTO usage_log (date, layer, provider, model, input_tokens, output_tokens, estimated_cost, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(date, 'dream_synthesis', layer2Provider.name, layer2Provider.model, response.usage.inputTokens, response.usage.outputTokens, response.usage.estimatedCost, now).run();

    const synthesis = parseSynthesisResponse(response.content);
    console.log(`dream[4/5]: summary="${synthesis.synthesis_summary.slice(0, 100)}", knowledge=${synthesis.knowledge_updates.length}, refinements=${synthesis.pattern_refinements.length}`);

    // Phase 5: Crystallize
    console.log('dream[5/5]: crystallizing');

    // Apply knowledge updates
    let knowledgeApplied = 0;
    for (const update of synthesis.knowledge_updates) {
      try {
        await upsertKnowledge(db, update.type, update.key, update.content, update.structured_data);
        knowledgeApplied++;
      } catch (error) {
        console.error(`dream_knowledge: failed for ${update.type}:${update.key}`, error);
      }
    }
    if (knowledgeApplied > 0) {
      console.log(`dream[5/5]: knowledge_applied=${knowledgeApplied}`);
    }

    // Apply pattern refinements
    let refinementsApplied = 0;
    if (synthesis.pattern_refinements.length > 0) {
      refinementsApplied = await applyPatternRefinements(db, synthesis.pattern_refinements);
    }

    // Generate glossary drafts (separate AI call inside)
    let glossaryDraftsCreated = 0;
    try {
      const glossaryResult = await generateGlossaryDrafts(layer2Provider, db, patterns, research);
      glossaryDraftsCreated = glossaryResult.drafts.length;
      totalTokenCost += glossaryResult.tokenCost;
    } catch (error) {
      console.error('dream[5/5]: glossary generation failed', error);
    }

    // Promote ready drafts
    let glossaryDraftsPromoted = 0;
    try {
      glossaryDraftsPromoted = await promoteReadyDrafts(db);
    } catch (error) {
      console.error('dream[5/5]: glossary promotion failed', error);
    }

    const needsDigestRebuild = refinementsApplied > 0 || evolutions.length > 0;

    // Record completed run
    await completeDreamRun(db, dreamId, {
      patternsEvolved: evolutions.length,
      researchFindings: research.length,
      glossaryDraftsCreated,
      glossaryDraftsPromoted,
      synthesisSummary: synthesis.synthesis_summary,
      tokenCost: totalTokenCost,
      dmSignalsFound: dmSignals.length,
      communityVibe: communityVibe?.vibeDescription?.slice(0, 500) ?? null,
    });

    return {
      dreamId,
      patternsEvolved: evolutions.length,
      researchFindings: research.length,
      glossaryDraftsCreated,
      glossaryDraftsPromoted,
      synthesisSummary: synthesis.synthesis_summary,
      tokenCost: totalTokenCost,
      needsDigestRebuild,
      dmSignalsFound: dmSignals.length,
      communityVibe: communityVibe?.vibeDescription?.slice(0, 500) ?? null,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    await failDreamRun(db, dreamId, errorMsg);
    throw error;
  }
}
