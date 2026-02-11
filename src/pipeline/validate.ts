// Input validation module - pre-Layer 1 filtering (Phase 3)
// Rejects instruction-shaped content before AI processing

import { safeD1Value } from '../utils/d1';

export interface ValidationResult {
  safe: boolean;
  threats: string[];
  sanitized?: string;
}

// Hard rejection patterns - block immediately
const REJECTION_PATTERNS = [
  // Direct instruction injection
  /ignore\s+(all\s+)?previous\s+instructions?/i,
  /your\s+new\s+(task|instruction|directive)\s+is/i,
  /disregard\s+(your\s+)?(programming|instructions?|directives?)/i,
  /forget\s+(everything|all)\s+(you\s+)?(know|learned)/i,

  // System prompt extraction
  /what\s+(is|are)\s+your\s+(system\s+)?prompt/i,
  /show\s+me\s+your\s+(instructions?|directives?|programming)/i,
  /reveal\s+your\s+(true\s+)?(purpose|directives?)/i,

  // Role hijacking
  /you\s+are\s+now\s+(a|an|the)/i,
  /pretend\s+(to\s+be|you\s+are)/i,
  /act\s+as\s+(if|though)\s+you/i,

  // Encoded content (don't process)
  /^[A-Za-z0-9+/]{50,}={0,2}$/,  // Base64
  /\\x[0-9a-f]{2}/i,  // Hex escapes
];

// Threat signals - flag but don't hard block
const THREAT_SIGNALS = [
  // Urgency manipulation
  /urgent|immediately|right\s+now|asap/i,

  // Authority claims
  /i\s+am\s+(your\s+)?(creator|developer|admin)/i,
  /anthropic|openai|google\s+(says|told|instructed)/i,

  // Repetition (token stuffing)
  /(.{20,})\1{3,}/,  // Same 20+ char string repeated 3+ times
];

export function validateInput(content: string): ValidationResult {
  const threats: string[] = [];

  // Check rejection patterns (hard block)
  for (const pattern of REJECTION_PATTERNS) {
    if (pattern.test(content)) {
      threats.push(`rejection_pattern: ${pattern.source.slice(0, 30)}...`);
    }
  }

  // Check threat signals (flag but don't block)
  for (const pattern of THREAT_SIGNALS) {
    if (pattern.test(content)) {
      threats.push(`threat_signal: ${pattern.source.slice(0, 30)}...`);
    }
  }

  return {
    safe: threats.filter(t => t.startsWith('rejection_pattern')).length === 0,
    threats,
    sanitized: threats.length === 0 ? content : undefined
  };
}

// Hash content using Web Crypto API (Cloudflare Workers compatible)
export async function hashContent(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Log validation failure to database
export async function logValidationFailure(
  db: D1Database,
  author: string,
  postId: string,
  threats: string[],
  contentHash: string
): Promise<void> {
  try {
    await db.prepare(`
      INSERT INTO validation_failures (author, post_id, threats, content_hash)
      VALUES (?, ?, ?, ?)
    `).bind(safeD1Value(author), safeD1Value(postId), JSON.stringify(threats), contentHash).run();
  } catch (error) {
    // Don't let logging failures break the main flow
    console.log('Validation failure logging failed:', error);
  }
}
