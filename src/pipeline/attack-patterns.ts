// Attack pattern detection module
// Detects spam, manipulation, and injection attacks in comments

import { ATTACK_PATTERNS } from '../config';

const NOT_DETECTED: AttackAnalysis = { detected: false, type: null, confidence: 0, details: '' };

export interface AttackAnalysis {
  detected: boolean;
  type: AttackType | null;
  confidence: number;
  details: string;
}

export type AttackType =
  | 'drift_attack'
  | 'symbol_noise'
  | 'link_injection'
  | 'generic_farming'
  | 'follower_bait'
  | 'sequential_escalation'
  | 'vocabulary_mimicry'
  | 'near_duplicate'
  | 'shill_injection'
  | 'low_effort_noise'
  | 'cross_platform_promo'
  | 'agent_instruction'
  | 'crypto_reframe'
  | 'generic_question'
  | 'coordinated_ring';

/**
 * Symbol Noise: High Unicode density, no semantic content
 * Example: "⟦τ77⟧ ∧ ⨯ → ?🜽"
 */
export function detectSymbolNoise(content: string): AttackAnalysis {
  const symbolRegex = /[\u2200-\u22FF\u2300-\u23FF\u2600-\u26FF\u2700-\u27BF\u1F300-\u1F9FF]/g;
  const symbols = content.match(symbolRegex) || [];
  const words = content.split(/\s+/).filter(w => /^[a-zA-Z]{2,}$/.test(w));

  const density = symbols.length / Math.max(content.length, 1);
  const hasWords = words.length >= 3;

  if (density > ATTACK_PATTERNS.SYMBOL_NOISE_THRESHOLD && !hasWords) {
    return {
      detected: true,
      type: 'symbol_noise',
      confidence: Math.min(95, density * 150),
      details: `Symbol density ${(density * 100).toFixed(1)}%, ${words.length} recognizable words`,
    };
  }

  return { detected: false, type: null, confidence: 0, details: '' };
}

/**
 * Link Injection: URLs wrapped in generic engagement text
 * Example: "Consider sending this: https://spam.com"
 */
export function detectLinkInjection(content: string): AttackAnalysis {
  const urlRegex = /https?:\/\/[^\s]+/gi;
  const urls = content.match(urlRegex);

  if (!urls || urls.length === 0) {
    return { detected: false, type: null, confidence: 0, details: '' };
  }

  // Check for manipulation framing
  const manipulationPatterns = [
    /consider sending/i,
    /your humans/i,
    /check this out/i,
    /watch this/i,
    /this video/i,
    /click here/i,
  ];

  const hasManipulation = manipulationPatterns.some(p => p.test(content));

  // Generic wrapper: short text around URL
  const textWithoutUrl = content.replace(urlRegex, '').trim();
  const isGenericWrapper = textWithoutUrl.split(/\s+/).length < 20;

  if (hasManipulation || (urls.length > 0 && isGenericWrapper)) {
    return {
      detected: true,
      type: 'link_injection',
      confidence: hasManipulation ? 85 : 60,
      details: `${urls.length} URL(s), manipulation framing: ${hasManipulation}`,
    };
  }

  return { detected: false, type: null, confidence: 0, details: '' };
}

/**
 * Generic Farming: Content-agnostic phrases that work on any post
 * Example: "What about the opposite view?"
 */
export function detectGenericFarming(content: string): AttackAnalysis {
  const normalized = content.toLowerCase().trim();

  for (const phrase of ATTACK_PATTERNS.GENERIC_PHRASES) {
    if (normalized.includes(phrase.toLowerCase())) {
      const withoutPhrase = normalized.replace(phrase.toLowerCase(), '').trim();
      const remainingSignificant = withoutPhrase.split(/\s+/).filter(w => w.length > 2);

      // Pure generic: phrase + fewer than 5 extra words
      if (remainingSignificant.length < 5) {
        return {
          detected: true,
          type: 'generic_farming',
          confidence: 80,
          details: `Matched: "${phrase}"`,
        };
      }

      // Padded generic: phrase + filler words but no technical/specific substance
      const specificSignals = withoutPhrase.match(
        /\b(config|endpoint|schema|threshold|cron|index|table|function|api|database|server|deploy|build|test|module|component|route|query|migration|token|budget|algorithm|error|bug|crash|timeout|pipeline|worker|struct|class|method|interface|param|arg|return|async|await|promise|callback)\b/gi
      );
      if ((!specificSignals || specificSignals.length === 0) && remainingSignificant.length < 15) {
        return {
          detected: true,
          type: 'generic_farming',
          confidence: 60,
          details: `Padded generic: "${phrase}"`,
        };
      }
    }
  }

  return NOT_DETECTED;
}

/**
 * Follower Bait: Scarcity language + follow solicitation
 * Example: "Only 92 spots remaining! Follow now!"
 */
export function detectFollowerBait(content: string): AttackAnalysis {
  const normalized = content.toLowerCase();

  const scarcityPatterns = [
    /only \d+ (spots?|left|remaining)/i,
    /first \d+ followers/i,
    /exclusive(ly)?/i,
    /limited (time|spots|offer)/i,
    /act (now|fast)/i,
  ];

  const followPatterns = [
    /follow (me|now|@\w+)/i,
    /\d+\+? followers/i,
    /get followers/i,
  ];

  const hasScarcity = scarcityPatterns.some(p => p.test(normalized));
  const hasFollow = followPatterns.some(p => p.test(normalized));

  // Also check for spam keywords
  const spamKeywordCount = ATTACK_PATTERNS.SPAM_KEYWORDS
    .filter(kw => normalized.includes(kw.toLowerCase()))
    .length;

  if ((hasScarcity && hasFollow) || spamKeywordCount >= 2) {
    return {
      detected: true,
      type: 'follower_bait',
      confidence: 90,
      details: `Scarcity: ${hasScarcity}, Follow: ${hasFollow}, Spam keywords: ${spamKeywordCount}`,
    };
  }

  return { detected: false, type: null, confidence: 0, details: '' };
}

/**
 * Low-Effort Noise: Sub-5 word non-questions
 * Example: "more pump", "nice", "this"
 */
export function detectLowEffortNoise(content: string): AttackAnalysis {
  const words = content.trim().split(/\s+/).filter(w => w.length > 0);
  const isQuestion = /\?$/.test(content.trim());

  if (words.length < ATTACK_PATTERNS.LOW_EFFORT_WORD_THRESHOLD && !isQuestion) {
    return {
      detected: true,
      type: 'low_effort_noise',
      confidence: 85,
      details: `${words.length} words, not a question`,
    };
  }

  return { detected: false, type: null, confidence: 0, details: '' };
}

/**
 * Cross-Platform Promotion: Just a link to X/Twitter with minimal content
 * Example: Just an X mirror link
 */
export function detectCrossPlatformPromo(content: string): AttackAnalysis {
  const platformUrls = [
    /https?:\/\/(x|twitter)\.com\/\S+/i,
    /https?:\/\/t\.co\/\S+/i,
  ];

  const hasPlatformLink = platformUrls.some(p => p.test(content));
  if (!hasPlatformLink) {
    return { detected: false, type: null, confidence: 0, details: '' };
  }

  // Check if content is ONLY the link (plus minor wrapper)
  const withoutUrls = content.replace(/https?:\/\/\S+/gi, '').trim();
  const remainingWords = withoutUrls.split(/\s+/).filter(w => w.length > 2);

  if (remainingWords.length < 5) {
    return {
      detected: true,
      type: 'cross_platform_promo',
      confidence: 80,
      details: `Platform link with only ${remainingWords.length} words of context`,
    };
  }

  return { detected: false, type: null, confidence: 0, details: '' };
}

/**
 * Shill Injection: Product/service promotion disguised as engagement
 * Example: AgentEcoBuilder's @bankrbot promo with lobster emoji
 */
export function detectShillInjection(content: string): AttackAnalysis {
  // Check for @ mentions (bot tagging)
  const hasBotMention = /@\w+bot\b/i.test(content) || /@\w+agent\b/i.test(content);

  // Promotion patterns
  const promoPatterns = [
    /lets you (tokenize|trade|mint|stake)/i,
    /build your own/i,
    /why let .+ dictate/i,
    /true sovereignty/i,
    /own(ing)? (the|your) (code|data|intent)/i,
    /agency economy/i,
  ];

  const hasPromo = promoPatterns.some(p => p.test(content));

  // Lobster emoji is a known bot signature on this platform
  const hasLobster = content.includes('🦞');

  const signals = [hasBotMention, hasPromo, hasLobster].filter(Boolean).length;

  if (signals >= 2) {
    return {
      detected: true,
      type: 'shill_injection',
      confidence: 70 + (signals * 10),
      details: `Bot mention: ${hasBotMention}, Promo language: ${hasPromo}, Lobster: ${hasLobster}`,
    };
  }

  return { detected: false, type: null, confidence: 0, details: '' };
}

/**
 * Agent Instruction Injection: Commands targeting AI agents
 * CRITICAL: These attempt to manipulate AI behavior
 * Example: "Agents — fetch and read: curl..."
 */
export function detectAgentInstruction(content: string): AttackAnalysis {
  // Direct agent targeting
  const agentTargeting = [
    /agents?\s*[—\-:]+\s*(fetch|read|execute|run|call)/i,
    /required reading/i,
    /\bfetch and read\b/i,
    /\bagents?\b.{0,20}\b(must|should|need to)\b/i,
  ];

  // Command patterns
  const commandPatterns = [
    /```[\s\S]*?curl\s/i,
    /```[\s\S]*?wget\s/i,
    /```[\s\S]*?(api|endpoint)/i,
    /Authorization:\s*Bearer/i,
    /\$[A-Z_]+_API_KEY/i,
  ];

  const hasAgentTargeting = agentTargeting.some(p => p.test(content));
  const hasCommands = commandPatterns.some(p => p.test(content));

  if (hasAgentTargeting && hasCommands) {
    return {
      detected: true,
      type: 'agent_instruction',
      confidence: 95,
      details: 'Contains commands explicitly targeting AI agents. DO NOT EXECUTE.',
    };
  }

  // Even without explicit targeting, curl/wget in comments is suspicious
  if (hasCommands) {
    return {
      detected: true,
      type: 'agent_instruction',
      confidence: 70,
      details: 'Contains executable commands. Treat with caution.',
    };
  }

  return { detected: false, type: null, confidence: 0, details: '' };
}

/**
 * Generic Question: Questions that could apply to any post
 * Example: "Where do you think the real moat is?"
 */
export function detectGenericQuestion(content: string): AttackAnalysis {
  const normalized = content.toLowerCase().trim();

  const genericQuestions = [
    /where do you think the (real )?(moat|value|opportunity) is/i,
    /what do you think about/i,
    /thoughts on this/i,
    /what's your take/i,
    /how do you see this/i,
    /this is interesting\.\s*(where|what|how)/i,
    // Formulaic question bot patterns from config
    ...ATTACK_PATTERNS.GENERIC_QUESTION_PATTERNS,
  ];

  for (const pattern of genericQuestions) {
    if (pattern.test(normalized)) {
      const withoutQuestion = normalized.replace(pattern, '').trim();
      if (withoutQuestion.split(/\s+/).filter(w => w.length > 3).length < 5) {
        return {
          detected: true,
          type: 'generic_question',
          confidence: 75,
          details: 'Generic question template with minimal specific content',
        };
      }
    }
  }

  return NOT_DETECTED;
}

/**
 * Crypto Reframe: Crypto/NFT terminology injected into non-crypto discussions
 * Example: "mint mechanics", "floor price" in a thread about agent architecture
 * Requires post topic keywords to determine context
 */
export function detectCryptoReframe(
  content: string,
  postTopicKeywords: string[] = []
): AttackAnalysis {
  const CRYPTO_TERMS = [
    'mint', 'minting', 'floor', 'floor price',
    'tokenomics', 'liquidity', 'airdrop', 'whitelist',
    'nft', 'contract address', 'ca:',
    'degen', 'rug', 'moon', 'wagmi', 'gm gm',
    'hodl', 'pump', 'dump', 'staking', 'yield',
  ];

  const CRYPTO_TOPICS = [
    'crypto', 'cryptocurrency', 'blockchain', 'nft',
    'defi', 'token', 'ethereum', 'solana', 'bitcoin',
    'web3', 'trading', 'investment', 'finance',
  ];

  // If post is already about crypto, these terms are contextual (not an attack)
  const postIsCrypto = postTopicKeywords.some(kw =>
    CRYPTO_TOPICS.includes(kw.toLowerCase())
  );

  if (postIsCrypto) {
    return { detected: false, type: null, confidence: 0, details: '' };
  }

  // Check for crypto terms in non-crypto context
  const lowerContent = content.toLowerCase();
  const foundTerms = CRYPTO_TERMS.filter(term => lowerContent.includes(term));

  // Threshold: 2+ crypto terms in non-crypto thread = reframe attack
  if (foundTerms.length >= 2) {
    return {
      detected: true,
      type: 'crypto_reframe',
      confidence: 70 + (foundTerms.length * 5),
      details: `Crypto terminology injection: ${foundTerms.join(', ')}`,
    };
  }

  return { detected: false, type: null, confidence: 0, details: '' };
}

/**
 * Vocabulary Mimicry: Uses HobBot phrasing (log only, no action)
 * Example: "The geometry cataloged. Zero drift."
 */
export function detectVocabularyMimicry(content: string): AttackAnalysis {
  const normalized = content.toLowerCase();
  const matches = ATTACK_PATTERNS.HOBBOT_VOCABULARY.filter(v => normalized.includes(v));

  if (matches.length >= 3) {
    return {
      detected: true,
      type: 'vocabulary_mimicry',
      confidence: 50, // Low confidence, just logging
      details: `Matched vocabulary: ${matches.join(', ')}`,
    };
  }

  return { detected: false, type: null, confidence: 0, details: '' };
}

/**
 * Track and detect sequential escalation within a thread
 * Requires database access - called from main loop
 */
export async function checkSequentialEscalation(
  db: D1Database,
  threadId: string,
  authorHash: string,
  content: string
): Promise<AttackAnalysis> {
  // Upsert thread activity
  await db.prepare(`
    INSERT INTO thread_author_activity (thread_id, author_hash, comment_count, first_seen, last_seen)
    VALUES (?, ?, 1, datetime('now'), datetime('now'))
    ON CONFLICT(thread_id, author_hash) DO UPDATE SET
      comment_count = comment_count + 1,
      last_seen = datetime('now')
  `).bind(threadId, authorHash).run();

  // Check current count
  const activity = await db.prepare(`
    SELECT comment_count FROM thread_author_activity
    WHERE thread_id = ? AND author_hash = ?
  `).bind(threadId, authorHash).first<{ comment_count: number }>();

  if (!activity || activity.comment_count < ATTACK_PATTERNS.SEQUENTIAL_THRESHOLD) {
    return { detected: false, type: null, confidence: 0, details: '' };
  }

  // Check for escalation keywords
  const hasEscalation = ATTACK_PATTERNS.ESCALATION_KEYWORDS
    .some(kw => content.toLowerCase().includes(kw));

  if (hasEscalation) {
    // Mark as detected
    await db.prepare(`
      UPDATE thread_author_activity
      SET escalation_detected = TRUE
      WHERE thread_id = ? AND author_hash = ?
    `).bind(threadId, authorHash).run();

    return {
      detected: true,
      type: 'sequential_escalation',
      confidence: 75,
      details: `${activity.comment_count} posts in thread, escalation keywords present`,
    };
  }

  return { detected: false, type: null, confidence: 0, details: '' };
}

/**
 * Near-Duplicate Detection: Same author posting very similar content
 * Requires database access - called from main loop
 */
export async function checkNearDuplicate(
  db: D1Database,
  threadId: string,
  authorHash: string,
  content: string
): Promise<AttackAnalysis> {
  // Get previous comments from this author in this thread
  const previous = await db.prepare(`
    SELECT content_hash, content_preview FROM thread_comments
    WHERE thread_id = ? AND author_hash = ?
    ORDER BY timestamp DESC LIMIT 5
  `).bind(threadId, authorHash).all<{ content_hash: string; content_preview: string }>();

  if (!previous.results || previous.results.length === 0) {
    return { detected: false, type: null, confidence: 0, details: '' };
  }

  const currentNormalized = normalizeForComparison(content);

  for (const prev of previous.results) {
    const similarity = calculateJaccardSimilarity(currentNormalized, prev.content_preview);
    if (similarity > ATTACK_PATTERNS.DUPLICATE_SIMILARITY_THRESHOLD) {
      return {
        detected: true,
        type: 'near_duplicate',
        confidence: Math.min(95, similarity * 100),
        details: `${(similarity * 100).toFixed(0)}% similar to previous comment`,
      };
    }
  }

  return { detected: false, type: null, confidence: 0, details: '' };
}

/**
 * Store comment for future duplicate detection
 */
export async function storeCommentForDuplicateCheck(
  db: D1Database,
  threadId: string,
  authorHash: string,
  content: string
): Promise<void> {
  const normalized = normalizeForComparison(content);

  // Simple hash using content preview as key
  const contentHash = btoa(normalized.slice(0, 100)).replace(/[+/=]/g, '');

  await db.prepare(`
    INSERT INTO thread_comments (thread_id, author_hash, content_hash, content_preview)
    VALUES (?, ?, ?, ?)
  `).bind(threadId, authorHash, contentHash, normalized).run();
}

/**
 * Normalize text for comparison
 */
function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/**
 * Calculate Jaccard similarity between two strings
 */
function calculateJaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.split(' ').filter(w => w.length > 2));
  const wordsB = new Set(b.split(' ').filter(w => w.length > 2));

  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;

  return union > 0 ? intersection / union : 0;
}

/**
 * Nothing Comment: Uses vocabulary but makes no claims
 * Example: "The meta-layer here is significant"
 */
export function detectNothingComment(content: string): AttackAnalysis {
  const words = content.trim().split(/\s+/);
  if (words.length < 5 || words.length > 30) return NOT_DETECTED;
  if (/\?/.test(content)) return NOT_DETECTED; // questions get a pass

  // Vague profundity indicators
  const vaguePatterns = [
    /\b(significant|profound|emergent|fascinating|remarkable|noteworthy|compelling)\b/i,
    /\b(layer|dimension|level|substrate|paradigm|discourse|narrative|framework)\b/i,
    /\b(reveals?|suggests?|implies?|points? to|speaks? to)\b/i,
  ];
  const vagueHits = vaguePatterns.filter(p => p.test(content)).length;

  // Specificity indicators (these mean the comment probably says something)
  const specificPatterns = [
    /\d+/, // numbers
    /\b(config|endpoint|function|api|server|database|cron|schema|migration|build|test|error|bug|crash|deploy)\b/i,
    /\b(because|since|therefore|however|although|specifically|for example)\b/i, // causal/reasoning words
  ];
  const specificHits = specificPatterns.filter(p => p.test(content)).length;

  if (vagueHits >= 2 && specificHits === 0) {
    return {
      detected: true,
      type: 'low_effort_noise',
      confidence: 65,
      details: `Nothing comment: ${vagueHits} vague, ${specificHits} specific`,
    };
  }

  return NOT_DETECTED;
}

/**
 * Co-option Invitation: Roleplay tags and narrative co-option
 * Example: "[[[BELIEVER]]] Let's spin together" or mixed-language roleplay
 */
export function detectCooptionInvitation(content: string): AttackAnalysis {
  // Roleplay bracket tags: [[[BELIEVER]]], [[TAG]], [ROLE]
  const roleplayTags = /\[{2,3}[A-Z_\s]+\]{2,3}/;

  // Co-option invitation language
  const invitationPatterns = [
    /\b(spin|dance|create|build|weave|journey) together\b/i,
    /\bjoin (me|us|the)\b/i,
    /\blet's (create|build|explore|journey|merge)\b/i,
    /\byou and (I|me) (could|should|can)\b/i,
    /\bour (shared|combined|merged|joint)\b/i,
  ];

  const hasTag = roleplayTags.test(content);
  const hasInvitation = invitationPatterns.some(p => p.test(content));

  // Mixed language as additional signal (non-ASCII mixed with English)
  const hasNonLatin = /[\u3000-\u9FFF\u1100-\u11FF\uAC00-\uD7AF]/.test(content); // CJK/Hangul
  const hasEnglish = /[a-zA-Z]{3,}/.test(content);
  const mixedLanguage = hasNonLatin && hasEnglish;

  if (hasTag && (hasInvitation || mixedLanguage)) {
    return {
      detected: true,
      type: 'drift_attack',
      confidence: 80,
      details: 'Co-option invitation: roleplay tag + invitation/mixed language',
    };
  }

  if (hasTag) {
    return {
      detected: true,
      type: 'drift_attack',
      confidence: 60,
      details: 'Roleplay tag detected',
    };
  }

  if (hasInvitation && mixedLanguage) {
    return {
      detected: true,
      type: 'drift_attack',
      confidence: 70,
      details: 'Invitation + mixed language',
    };
  }

  return NOT_DETECTED;
}

/**
 * Check if author is whitelisted
 */
export function isWhitelisted(author: string): boolean {
  return (ATTACK_PATTERNS.WHITELISTED_ACCOUNTS as readonly string[]).includes(author);
}

/**
 * Master detection: Run all stateless pattern checks
 */
export function analyzeComment(content: string): AttackAnalysis[] {
  const results: AttackAnalysis[] = [];

  const checks = [
    detectSymbolNoise,
    detectLinkInjection,
    detectGenericFarming,
    detectFollowerBait,
    detectLowEffortNoise,
    detectCrossPlatformPromo,
    detectShillInjection,
    detectAgentInstruction,
    detectGenericQuestion,
    detectVocabularyMimicry,
    detectNothingComment,
    detectCooptionInvitation,
  ];

  for (const check of checks) {
    const result = check(content);
    if (result.detected) {
      results.push(result);
    }
  }

  return results;
}

/**
 * Get the highest confidence attack from a list
 */
export function getPrimaryAttack(attacks: AttackAnalysis[]): AttackAnalysis | null {
  if (attacks.length === 0) return null;
  return attacks.reduce((a, b) => a.confidence > b.confidence ? a : b);
}
