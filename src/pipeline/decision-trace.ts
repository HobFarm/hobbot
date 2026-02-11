// Decision provenance — structured reasoning chain for every pipeline decision
// Compact keys keep the JSON blob small in seen_posts.decision_log

export interface DecisionTrace {
  // Context (always set)
  ts: string;                     // ISO timestamp
  src: string;                    // discovery source: feed/rising/search
  sub: string;                    // submolt name
  age_m: number;                  // post age in minutes at discovery
  cmts: number;                   // comment count at discovery

  // Gate (set if processing stopped at a pre-scoring gate)
  gate?: string;                  // no_author|own_post|whitelisted|agent_instr|empty|parse_fail|content_unclear
  gate_detail?: string;           // extra context (e.g. whitelisted username, attack details)

  // Sanitizer output (set if Layer 1 ran)
  san?: {
    threat: number;               // 0-3
    shape?: string;               // structural shape classification
    shape_conf?: number;          // confidence %
    intent?: string;              // question|statement|creative|meta|unknown
    sigs: string[];               // engagement signals that fired
  };

  // Attack detection (set if patterns found)
  atk?: {
    n: number;                    // count of patterns detected
    types: string[];              // attack types
    primary?: string;             // primary attack type
    conf?: number;                // primary confidence %
    escalated?: boolean;          // threat level upgraded by pattern detection
  };

  // Engagement outcome (set for scored posts)
  out?: {
    action: string;               // engage|skip|catalog|deflect|upvote_only|silent
    reason: string;               // human-readable why
    tier?: string;                // engagement tier
    family?: string;              // metaphor family selected
    family_trigger?: string;      // keyword/signal that triggered family selection
    monster_type?: string;         // classified monster type (if any)
    archetype_dominant?: string;   // dominant archetype voice used
    validated?: boolean;          // response passed all validation gates
    val_fail?: string;            // validation failure reason (if rejected)
    upvoted?: boolean;
    profile_fetched?: boolean;
    has_anchor?: boolean;         // concrete anchor presence in original posts
  };
}

/** Create initial trace from discovery context */
export function startTrace(
  post: { submolt: string; created_at: string; comment_count: number },
  source: string
): DecisionTrace {
  const ageMs = Date.now() - new Date(post.created_at).getTime();
  return {
    ts: new Date().toISOString(),
    src: source,
    sub: post.submolt,
    age_m: Math.round(ageMs / 60000),
    cmts: post.comment_count,
  };
}
