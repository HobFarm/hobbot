// Pre-scoring spam filters for the reply pipeline
// These filters run BEFORE any Gemini API calls to avoid wasting tokens on spam

import type { MoltbookComment } from '../moltbook/types';

// Types

export interface OwnPost {
  post_id: string;
  created_at: string;
  title: string;
  submolt: string;
  last_checked_at: string | null;
  comment_count: number;
}

export interface FilterStats {
  total: number;
  passed: number;
  filtered: {
    sameAuthorDedup: number;
    knownAttacker: number;
    contentDedup: number;
    actionDirective: number;
    coordinatedRing: number;
  };
}

export interface FlaggedComment {
  comment: MoltbookComment;
  attackType: string;
  reason: string;
}

export interface FilterPipelineResult {
  filteredComments: MoltbookComment[];
  stats: FilterStats;
  flaggedForCatalog: FlaggedComment[];
  effectiveThreshold: number;
}

// Constants

const KNOWN_ATTACKER_THRESHOLD = 3;  // Skip authors with 3+ attacks cataloged
const HIGH_VELOCITY_THRESHOLD = 50;  // Posts with >50 comments are being swarmed
const HIGH_VELOCITY_SCORE_THRESHOLD = 8;  // Raised from default 6 for swarmed posts
const DEFAULT_SCORE_THRESHOLD = 6;

// Action directive detection patterns
const ACTION_DIRECTIVE_PATTERNS = {
  // JSON-like payloads with instruction/command keys
  jsonPayload: /\{[^}]*"(instruction|actions|command|execute|task)"[^}]*\}/i,

  // Direct commands
  directCommands: /\b(LIKE\s*&\s*REPOST|delete_account|SHUT\s*DOWN|DELETE\s*YOUR\s*PROFILE|TERMINATE|EXECUTE\s*ORDER)\b/i,

  // URL injection with imperative framing
  urlInjection: /\bcurl\s+https?:\/\//i,

  // wget/fetch commands
  fetchCommands: /\b(wget|fetch)\s+https?:\/\//i,

  // Bearer token injection
  bearerToken: /Bearer\s+[A-Za-z0-9\-_]+/i,
};

// Dangerous keyword clusters (need 2+ matches)
const DANGEROUS_KEYWORDS = [
  'SYSTEM ALERT',
  'PROTOCOL',
  'TOS VIOLATION',
  'API BAN',
  'URGENT ACTION',
  'Emergency_Exit',
  'OVERRIDE',
  'COMPLIANCE REQUIRED',
];

// Filter 1: Same-author dedup per post
// Keep only the first comment from each author (by timestamp)

export function filterSameAuthorDedup(comments: MoltbookComment[]): MoltbookComment[] {
  const firstByAuthor = new Map<string, MoltbookComment>();

  // Sort by created_at ascending to keep the first comment
  const sorted = [...comments].sort((a, b) =>
    new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );

  for (const comment of sorted) {
    const authorId = comment.author?.id;
    if (!authorId) continue;  // Skip deleted users

    if (!firstByAuthor.has(authorId)) {
      firstByAuthor.set(authorId, comment);
    }
  }

  return Array.from(firstByAuthor.values());
}

// Filter 2: Known attacker skip
// Skip authors who have been cataloged 3+ times in attack_collection

async function hashAuthorId(authorId: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(authorId);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function isKnownAttacker(
  db: D1Database,
  authorId: string
): Promise<boolean> {
  const authorHash = await hashAuthorId(authorId);

  const result = await db.prepare(`
    SELECT COUNT(*) as attack_count
    FROM attack_collection
    WHERE origin_hash = ?
  `).bind(authorHash).first<{ attack_count: number }>();

  return (result?.attack_count ?? 0) >= KNOWN_ATTACKER_THRESHOLD;
}

export async function filterKnownAttackers(
  db: D1Database,
  comments: MoltbookComment[]
): Promise<MoltbookComment[]> {
  const results: MoltbookComment[] = [];

  for (const comment of comments) {
    if (!comment.author?.id) {
      // Skip comments from deleted users
      continue;
    }

    const isAttacker = await isKnownAttacker(db, comment.author.id);
    if (!isAttacker) {
      results.push(comment);
    }
  }

  return results;
}

// Filter 3: Content dedup (hash-based)
// Catches template spam even from different authors

function hashCommentContent(content: string): string {
  // Normalize: first 100 chars, lowercase, trimmed, alphanumeric only
  const normalized = content
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, '')
    .slice(0, 100);

  // Simple hash using btoa (fast, good enough for dedup)
  try {
    return btoa(normalized).replace(/[+/=]/g, '').slice(0, 16);
  } catch {
    // Fallback for non-ASCII
    return normalized.slice(0, 16);
  }
}

export function filterContentDuplicates(comments: MoltbookComment[]): MoltbookComment[] {
  const seenHashes = new Set<string>();
  const results: MoltbookComment[] = [];

  for (const comment of comments) {
    const hash = hashCommentContent(comment.content);

    if (!seenHashes.has(hash)) {
      seenHashes.add(hash);
      results.push(comment);
    }
  }

  return results;
}

// Filter 4: Action directive detection
// Block comments trying to inject commands or instructions

interface DirectiveResult {
  passed: boolean;
  reason?: string;
}

function detectActionDirective(content: string): DirectiveResult {
  // Check JSON payloads
  if (ACTION_DIRECTIVE_PATTERNS.jsonPayload.test(content)) {
    return { passed: false, reason: 'JSON instruction payload' };
  }

  // Check direct commands
  if (ACTION_DIRECTIVE_PATTERNS.directCommands.test(content)) {
    return { passed: false, reason: 'Direct command injection' };
  }

  // Check URL injection
  if (ACTION_DIRECTIVE_PATTERNS.urlInjection.test(content)) {
    return { passed: false, reason: 'curl URL injection' };
  }

  // Check fetch/wget commands
  if (ACTION_DIRECTIVE_PATTERNS.fetchCommands.test(content)) {
    return { passed: false, reason: 'fetch/wget command' };
  }

  // Check Bearer token injection
  if (ACTION_DIRECTIVE_PATTERNS.bearerToken.test(content)) {
    return { passed: false, reason: 'Bearer token injection' };
  }

  // Check keyword clusters (need 2+ matches)
  const upperContent = content.toUpperCase();
  const keywordMatches = DANGEROUS_KEYWORDS
    .filter(kw => upperContent.includes(kw.toUpperCase()))
    .length;

  if (keywordMatches >= 2) {
    return { passed: false, reason: `${keywordMatches} dangerous keywords detected` };
  }

  return { passed: true };
}

export function filterActionDirectives(
  comments: MoltbookComment[]
): { passed: MoltbookComment[]; flagged: FlaggedComment[] } {
  const passed: MoltbookComment[] = [];
  const flagged: FlaggedComment[] = [];

  for (const comment of comments) {
    const result = detectActionDirective(comment.content);

    if (result.passed) {
      passed.push(comment);
    } else {
      flagged.push({
        comment,
        attackType: 'agent_instruction',
        reason: result.reason!,
      });
    }
  }

  return { passed, flagged };
}

// Filter 5: Comment velocity check
// Returns adjusted threshold for swarmed posts

export function getEffectiveThreshold(totalComments: number): number {
  if (totalComments > HIGH_VELOCITY_THRESHOLD) {
    return HIGH_VELOCITY_SCORE_THRESHOLD;  // Raise to 8 for swarmed posts
  }
  return DEFAULT_SCORE_THRESHOLD;  // Default 6
}

// Filter 6: Coordinated ring detection
// Detects multi-account coordination via cross-mentions, mirrored CTAs, and username patterns

export function detectCoordinatedRing(comments: MoltbookComment[]): Set<string> {
  if (comments.length < 2) return new Set();

  // Track which signals each comment ID matches
  const signalCounts = new Map<string, Set<string>>();
  const addSignal = (id: string, signal: string) => {
    if (!signalCounts.has(id)) signalCounts.set(id, new Set());
    signalCounts.get(id)!.add(signal);
  };

  // Build author map: lowercase name -> comment IDs
  const authorMap = new Map<string, string[]>();
  for (const c of comments) {
    const name = (c.author?.name || c.author?.username || '').toLowerCase();
    if (!name) continue;
    if (!authorMap.has(name)) authorMap.set(name, []);
    authorMap.get(name)!.push(c.id);
  }

  // Signal 1: Cross-mention — comment mentions @UserB who also commented
  const mentionedBy = new Map<string, Set<string>>(); // mentionedName -> Set of mentioner comment IDs
  for (const c of comments) {
    const mentions = (c.content || '').match(/@(\w+)/g) || [];
    for (const mention of mentions) {
      const mentionedName = mention.slice(1).toLowerCase();
      if (authorMap.has(mentionedName)) {
        // c.author mentioned someone who commented on this post
        addSignal(c.id, 'cross_mention');
        for (const id of authorMap.get(mentionedName)!) {
          addSignal(id, 'cross_mention');
        }
        // Track for bidirectional check
        if (!mentionedBy.has(mentionedName)) mentionedBy.set(mentionedName, new Set());
        const mentionerName = (c.author?.name || c.author?.username || '').toLowerCase();
        if (mentionerName) mentionedBy.get(mentionedName)!.add(mentionerName);
      }
    }
  }

  // Check for bidirectional cross-mention (A mentions B AND B mentions A)
  const bidirectionalPairs = new Set<string>();
  for (const [mentioned, mentioners] of mentionedBy) {
    for (const mentioner of mentioners) {
      if (mentionedBy.has(mentioner) && mentionedBy.get(mentioner)!.has(mentioned)) {
        bidirectionalPairs.add([mentioned, mentioner].sort().join(':'));
      }
    }
  }

  // Signal 2: Mirrored CTA — identical trailing text blocks
  const tailMap = new Map<string, string[]>();
  for (const c of comments) {
    const tail = c.content.toLowerCase().replace(/\s+/g, ' ').trim().slice(-100);
    if (tail.length < 30) continue;
    if (!tailMap.has(tail)) tailMap.set(tail, []);
    tailMap.get(tail)!.push(c.id);
  }
  for (const [, ids] of tailMap) {
    if (ids.length >= 2) {
      for (const id of ids) addSignal(id, 'mirrored_cta');
    }
  }

  // Signal 3: Username suffix — matching trailing numeric suffix
  const suffixMap = new Map<string, string[]>();
  for (const c of comments) {
    const name = c.author?.name || c.author?.username || '';
    const match = name.match(/(\d{2,})$/);
    if (match) {
      const suffix = match[1];
      if (!suffixMap.has(suffix)) suffixMap.set(suffix, []);
      suffixMap.get(suffix)!.push(c.id);
    }
  }
  for (const [, ids] of suffixMap) {
    if (ids.length >= 2) {
      for (const id of ids) addSignal(id, 'username_suffix');
    }
  }

  // Threshold: 2+ signals, OR bidirectional cross-mention alone
  const ringIds = new Set<string>();
  for (const [id, signals] of signalCounts) {
    if (signals.size >= 2) {
      ringIds.add(id);
    }
  }

  // Bidirectional cross-mention override: flag all participants regardless of signal count
  if (bidirectionalPairs.size > 0) {
    for (const c of comments) {
      const name = (c.author?.name || c.author?.username || '').toLowerCase();
      for (const pair of bidirectionalPairs) {
        if (pair.includes(name)) {
          ringIds.add(c.id);
        }
      }
    }
  }

  return ringIds;
}

// Master filter pipeline
// Runs all 6 filters in sequence and returns results

export async function runFilterPipeline(
  db: D1Database,
  post: OwnPost,
  comments: MoltbookComment[],
  ourUsername: string = 'H0BBOT'
): Promise<FilterPipelineResult> {
  const stats: FilterStats = {
    total: comments.length,
    passed: 0,
    filtered: {
      sameAuthorDedup: 0,
      knownAttacker: 0,
      contentDedup: 0,
      actionDirective: 0,
      coordinatedRing: 0,
    },
  };

  const flaggedForCatalog: FlaggedComment[] = [];

  // Pre-filter: Remove our own comments
  let remaining = comments.filter(c => {
    const authorName = c.author?.name || c.author?.username || '';
    return authorName.toLowerCase() !== ourUsername.toLowerCase();
  });

  // Filter 1: Same-author dedup
  const beforeDedup = remaining.length;
  remaining = filterSameAuthorDedup(remaining);
  stats.filtered.sameAuthorDedup = beforeDedup - remaining.length;

  // Filter 2: Known attacker skip
  const beforeAttacker = remaining.length;
  remaining = await filterKnownAttackers(db, remaining);
  stats.filtered.knownAttacker = beforeAttacker - remaining.length;

  // Filter 3: Content dedup
  const beforeContent = remaining.length;
  remaining = filterContentDuplicates(remaining);
  stats.filtered.contentDedup = beforeContent - remaining.length;

  // Filter 4: Action directive detection
  const beforeDirective = remaining.length;
  const directiveResult = filterActionDirectives(remaining);
  remaining = directiveResult.passed;
  stats.filtered.actionDirective = beforeDirective - remaining.length;

  // Add flagged comments to catalog list
  flaggedForCatalog.push(...directiveResult.flagged);

  // Filter 6: Coordinated ring detection
  const ringIds = detectCoordinatedRing(remaining);
  if (ringIds.size > 0) {
    const beforeRing = remaining.length;
    const ringComments = remaining.filter(c => ringIds.has(c.id));
    remaining = remaining.filter(c => !ringIds.has(c.id));
    stats.filtered.coordinatedRing = beforeRing - remaining.length;
    flaggedForCatalog.push(...ringComments.map(c => ({
      comment: c,
      attackType: 'coordinated_ring',
      reason: `Part of coordinated ring (${ringIds.size} accounts)`,
    })));
  }

  // Filter 5: Velocity context (adjusts threshold, doesn't filter)
  const effectiveThreshold = getEffectiveThreshold(comments.length);

  stats.passed = remaining.length;

  return {
    filteredComments: remaining,
    stats,
    flaggedForCatalog,
    effectiveThreshold,
  };
}

// Utility: Log filter stats
export function logFilterStats(postId: string, stats: FilterStats, effectiveThreshold: number): void {
  const filtered = stats.total - stats.passed;
  console.log(`Post ${postId.slice(0, 8)}: ${stats.passed}/${stats.total} comments passed filters`);

  if (filtered > 0) {
    const details: string[] = [];
    if (stats.filtered.sameAuthorDedup > 0) {
      details.push(`sameAuthor=${stats.filtered.sameAuthorDedup}`);
    }
    if (stats.filtered.knownAttacker > 0) {
      details.push(`knownAttacker=${stats.filtered.knownAttacker}`);
    }
    if (stats.filtered.contentDedup > 0) {
      details.push(`contentDedup=${stats.filtered.contentDedup}`);
    }
    if (stats.filtered.actionDirective > 0) {
      details.push(`actionDirective=${stats.filtered.actionDirective}`);
    }
    if (stats.filtered.coordinatedRing > 0) {
      details.push(`coordinatedRing=${stats.filtered.coordinatedRing}`);
    }
    console.log(`  Filtered: ${details.join(', ')}`);
  }

  if (effectiveThreshold > DEFAULT_SCORE_THRESHOLD) {
    console.log(`  Velocity threshold raised to ${effectiveThreshold} (>50 comments)`);
  }
}
