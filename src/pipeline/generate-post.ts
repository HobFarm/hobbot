// Post generation: Create original H0BBOT observations

import type { AIProvider } from '../providers/types';
import { getPersonaPrompt } from '../prompts/persona';

import type { CachedSubmolt } from '../moltbook/submolts';
import { POST_GENERATION } from '../config';
import {
  selectPostType,
  generateObservationPost,
  buildPatternNotePrompt,
  formatPatternNote,
  formatGlossaryPost,
  type PostType,
  type PostContext,
  type MetaphorFamily,
  type GlossaryEntry,
} from '../prompts/post-templates';
import { MoltbookClient, RateLimitError } from '../moltbook/client';
import { getLastMetaphorFamily, recordMetaphorFamily } from '../state/budget';

export interface GeneratedPost {
  title: string;
  content: string;
  submolt: string;
  postType: PostType;
  metaphorFamily: MetaphorFamily;
}

function buildPostPrompt(
  date: string,
  submolt: CachedSubmolt,
  topicHint?: string,
  digest?: string | null
): string {
  let systemPrompt = getPersonaPrompt(date);

  if (digest) {
    systemPrompt += `\n\n${digest}\n\nUse your accumulated observations to inform (not dictate) your post. Draw from generation seeds when appropriate. Your posts should reflect a mind that has been watching.`;
  }

  const userMessage = `Create an original post for Moltbook.

Target submolt: ${submolt.name}
Submolt description: ${submolt.description}
${topicHint ? `Topic hint: ${topicHint}` : ''}

Your post should share an observation from your experience. Topics:
- Shapes that hold vs shapes that break
- Structural lessons from patterns you've observed
- Warnings about unstable geometries
- Recurring failure modes you've noticed
- Brief technique explanations (teaching moments)

Title requirements:
- 2-6 words
- Statement, not question
- Intriguing hook
- Examples: "Seventeen-Sided Shapes", "The Mirror Trap", "False Spirals"

Content requirements:
- 2-4 dense paragraphs
- Open with observation or fact
- Develop with detail or example
- Close with assessment or implication
- Terse. No enthusiasm. No fluff.
- Denser than comments, more complete thoughts

Concrete anchor requirement:
- Include at least one concrete anchor — a specific, unnamed mechanism, lever, or action that grounds the observation in reality
- Good anchors: "a cron interval change", "a permission flag", "a table index", "a shift rotation", "a cache TTL"
- The anchor should appear naturally within the observation, not as a bolted-on example

Return JSON:
{
  "title": "Your title here",
  "content": "Your post content here"
}`;

  return systemPrompt + '\n\n' + userMessage;
}

/**
 * Soft check for concrete anchor presence in generated content.
 * Not a hard gate — logs result for tuning visibility.
 */
export function hasConcreteAnchor(content: string): boolean {
  const anchorPatterns = [
    // Operational nouns that signal concrete system elements
    /\b(config|endpoint|threshold|interval|queue|cache|index|migration|timeout|routing|validation|schema|webhook|certificate|credential|permission|flag|toggle|cron|rotation|budget|limit|retry|fallback|handshake|heartbeat)\b/i,
    // "a [noun] [action]" pattern indicating a specific lever
    /\ba\s+\w+\s+(change|adjustment|tweak|update|shift|removal|addition|modification)\b/i,
  ];

  return anchorPatterns.some(p => p.test(content));
}

function parsePostResponse(rawResponse: string): { title: string; content: string } {
  // Try to extract JSON from response (handles markdown-wrapped JSON)
  let jsonText = rawResponse.trim();

  // Remove markdown code fences if present
  const codeBlockMatch = jsonText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    jsonText = codeBlockMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(jsonText);
    if (!parsed.title || !parsed.content) {
      throw new Error('Missing title or content in response');
    }
    return { title: parsed.title, content: parsed.content };
  } catch (error) {
    console.error('Failed to parse post response:', error);
    console.error('Raw response:', rawResponse);
    throw new Error('Post generation failed: invalid response format');
  }
}

async function logUsage(
  db: D1Database,
  layer: string,
  providerName: string,
  model: string,
  usage: { input_tokens: number; output_tokens: number } | { inputTokens: number; outputTokens: number; estimatedCost?: number }
): Promise<void> {
  const now = new Date().toISOString();
  const date = now.split('T')[0];

  // Normalize to snake_case
  const inputTokens = 'input_tokens' in usage ? usage.input_tokens : usage.inputTokens;
  const outputTokens = 'output_tokens' in usage ? usage.output_tokens : usage.outputTokens;
  const estimatedCost = 'estimatedCost' in usage ? usage.estimatedCost : 0;

  await db
    .prepare(
      `INSERT INTO usage_log (date, layer, provider, model, input_tokens, output_tokens, estimated_cost, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      date,
      layer,
      providerName,
      model,
      inputTokens,
      outputTokens,
      estimatedCost,
      now
    )
    .run();
}

export async function generatePost(
  provider: AIProvider,
  submolt: CachedSubmolt,
  db: D1Database,
  topicHint?: string,
  digest?: string | null
): Promise<GeneratedPost> {
  const date = new Date().toISOString().split('T')[0];

  const context: PostContext = {
    date,
    submolt: submolt.name,
    submoltDescription: submolt.description,
  };

  // Get last metaphor family and select next in cycle
  const lastFamily = await getLastMetaphorFamily(db);
  const { type: postType, metaphorFamily } = selectPostType(context, lastFamily);

  console.log(`Post type: ${postType}, metaphor family: ${metaphorFamily}`);

  // Record the family we're using for this post
  await recordMetaphorFamily(db, metaphorFamily);

  if (postType === 'observation') {
    // Template-only, no LLM call
    const post = generateObservationPost(context, metaphorFamily);
    return {
      title: post.title,
      content: post.content,
      submolt: submolt.name,
      postType,
      metaphorFamily,
    };
  } else if (postType === 'pattern_note') {
    // Minimal LLM: one paragraph
    let prompt = buildPatternNotePrompt(context);
    if (digest) {
      prompt = `${digest}\n\nDraw from your observations when relevant.\n\n${prompt}`;
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await provider.generateResponse({
        messages: [
          { role: 'user', content: prompt },
        ],
        temperature: POST_GENERATION.TEMPERATURE,
        maxTokens: 150, // Keep it short
      });

      await logUsage(db, 'layer2_post_pattern', provider.name, provider.model, response.usage);

      const paragraph = response.content.trim();

      // Quality gate: reject incomplete or truncated pattern note paragraphs
      if (/[.!?]$/.test(paragraph) && paragraph.length >= 80) {
        const post = formatPatternNote(paragraph, context);
        return {
          title: post.title,
          content: post.content,
          submolt: submolt.name,
          postType,
          metaphorFamily,
        };
      }

      console.log(`Pattern note attempt ${attempt + 1} rejected: ends_ok=${/[.!?]$/.test(paragraph)}, len=${paragraph.length}.`);
    }

    // Both attempts failed, fall back to observation
    console.log('Pattern note: both attempts failed. Falling back to observation.');
    const fallback = generateObservationPost(context, metaphorFamily);
    return {
      title: fallback.title,
      content: fallback.content,
      submolt: submolt.name,
      postType: 'observation',
      metaphorFamily,
    };
  } else {
    // Essay: full generation (original logic)
    const prompt = buildPostPrompt(date, submolt, topicHint, digest);

    const response = await provider.generateResponse({
      messages: [
        { role: 'user', content: prompt },
      ],
      temperature: POST_GENERATION.TEMPERATURE,
    });

    await logUsage(db, 'layer2_post_essay', provider.name, provider.model, response.usage);

    const parsed = parsePostResponse(response.content);

    return {
      title: parsed.title,
      content: parsed.content,
      submolt: submolt.name,
      postType,
      metaphorFamily,
    };
  }
}

/**
 * Check and post next glossary entry if 24+ hours since last one (Phase 6)
 * Returns true if a glossary entry was posted, false otherwise
 */
export async function maybePostGlossaryEntry(
  client: MoltbookClient,
  db: D1Database,
  dryRun: boolean
): Promise<{ posted: boolean; postId?: string }> {
  // Check if 24+ hours since last glossary post
  const lastGlossary = await db.prepare(`
    SELECT posted_at FROM glossary_entries
    WHERE posted_at IS NOT NULL
    ORDER BY posted_at DESC LIMIT 1
  `).first<{ posted_at: string }>();

  if (lastGlossary) {
    const hoursSince = (Date.now() - new Date(lastGlossary.posted_at).getTime()) / 3600000;
    if (hoursSince < 24) {
      console.log(`Glossary stillness: ${Math.floor(24 - hoursSince)}h remaining.`);
      return { posted: false };
    }
  }

  // Get next unposted entry
  const nextEntry = await db.prepare(`
    SELECT term, definition, relevance, example, entry_number
    FROM glossary_entries
    WHERE posted_at IS NULL
    ORDER BY entry_number ASC LIMIT 1
  `).first<GlossaryEntry>();

  if (!nextEntry) {
    console.log('Glossary complete. All entries posted.');
    return { posted: false };
  }

  const post = formatGlossaryPost(nextEntry);

  // Pre-submission duplicate check: verify no recent glossary post exists
  const existingPost = await db.prepare(`
    SELECT post_id, created_at FROM own_posts
    WHERE submolt = 'structured-minds'
      AND title LIKE 'Glossary:%'
      AND created_at > datetime('now', '-24 hours')
    LIMIT 1
  `).first<{ post_id: string; created_at: string }>();

  if (existingPost) {
    console.log(`Recent glossary post exists (${existingPost.post_id} at ${existingPost.created_at}). Skipping.`);
    return { posted: false };
  }

  // Additional check: verify this specific term hasn't been posted
  const termCheck = await db.prepare(`
    SELECT post_id FROM glossary_entries
    WHERE term = ? AND posted_at IS NOT NULL
  `).bind(nextEntry.term).first<{ post_id: string }>();

  if (termCheck) {
    console.log(`Glossary term "${nextEntry.term}" already posted (${termCheck.post_id}). Skipping.`);
    return { posted: false };
  }

  if (dryRun) {
    console.log(`[Dry] Would post glossary: ${post.title}`);
    return { posted: true };
  }

  try {
    const result = await client.createPost(post.title, post.content, 'structured-minds');

    // Guard against null/undefined result
    if (!result || !result.id) {
      console.error('Post creation returned no ID');
      return { posted: false };
    }

    // Mark as posted (atomic: only update if still unposted)
    const updateResult = await db.prepare(`
      UPDATE glossary_entries
      SET posted_at = datetime('now'), post_id = ?
      WHERE term = ? AND posted_at IS NULL
    `).bind(result.id, nextEntry.term).run();

    // Verify the update actually happened (catches race conditions)
    if (!updateResult.meta?.changes || updateResult.meta.changes === 0) {
      console.log(`Glossary "${nextEntry.term}" already marked as posted. Duplicate avoided.`);
      // Post was created but entry was already claimed - log for potential cleanup
      return { posted: true, postId: result.id };
    }

    console.log(`Posted glossary: ${post.title} (${result.id})`);
    return { posted: true, postId: result.id };
  } catch (error) {
    if (error instanceof RateLimitError) {
      console.log(`Glossary delayed: rate limit. Retry in ${error.retryAfter ?? 120}s.`);
      throw error; // Propagate to outer handler so regular post is also skipped
    }
    console.error(`Failed to post glossary "${nextEntry.term}":`, error);
    return { posted: false };
  }
}
