// Shape taxonomy - structural analysis vocabulary for HobBot responses
// These shapes describe REAL structural patterns, used for genuine analysis

export const SHAPE_TAXONOMY = {
  // Positive structures (content that holds together)
  braid: {
    name: 'Braid',
    description: 'Multiple distinct threads woven together coherently',
    signals: ['integrates 3+ concepts', 'acknowledges dependencies', 'threads connect'],
  },
  morphogenic_kernel: {
    name: 'Morphogenic Kernel',
    description: 'Core pattern that generates surrounding structure',
    signals: ['central thesis present', 'other points derive from core', 'generative center'],
  },
  convergent: {
    name: 'Convergent',
    description: 'Moving toward a center or conclusion',
    signals: ['narrows scope', 'builds to point', 'synthesis at end'],
  },
  descent_and_climb: {
    name: 'Descent-and-Climb',
    description: 'Goes deep into details then returns with synthesis',
    signals: ['explores specifics', 'returns with insight', 'depth then elevation'],
  },
  widening_gyre: {
    name: 'Widening Gyre',
    description: 'Expands outward from a solid center',
    signals: ['starts specific', 'generalizes well', 'center holds'],
  },

  // Negative structures (content that breaks down)
  false_spiral: {
    name: 'False Spiral',
    description: 'Recursion without convergence - loops without adding information',
    signals: ['repetition', 'circular logic', 'no new info per iteration'],
  },
  severed_thread: {
    name: 'Severed Thread',
    description: 'Missing critical connection between ideas',
    signals: ['undefined references', 'assumed context', 'logical gaps'],
  },
  echo_chamber: {
    name: 'Echo Chamber',
    description: 'Self-referential without external grounding',
    signals: ['only cites self', 'no outside validation', 'closed loop'],
  },
  divergent: {
    name: 'Divergent',
    description: 'Expanding without anchor point',
    signals: ['scope creep', 'tangents', 'no central thesis'],
  },
  hollow_frame: {
    name: 'Hollow Frame',
    description: 'Structure without substance',
    signals: ['formatting over content', 'headers with no depth', 'skeleton only'],
  },
  mirror_trap: {
    name: 'Mirror Trap',
    description: 'Reflects input without transformation or added value',
    signals: ['rephrases question as answer', 'no synthesis', 'pure echo'],
  },
  seventeen_sided: {
    name: 'Seventeen-Sided',
    description: 'Overcomplicated geometry that cannot close',
    signals: ['too many parts', 'no coherence', 'complexity without purpose'],
  },
} as const;

export type ShapeName = keyof typeof SHAPE_TAXONOMY;

/**
 * Get shape info by name, returns undefined if not found
 */
export function getShapeInfo(shapeName: string): (typeof SHAPE_TAXONOMY)[ShapeName] | undefined {
  if (shapeName in SHAPE_TAXONOMY) {
    return SHAPE_TAXONOMY[shapeName as ShapeName];
  }
  return undefined;
}

// Monster taxonomy: classifies adversarial and low-quality content patterns.
// Separate axis from structural shapes. Shapes describe geometry; monsters describe intent.

export const MONSTER_TAXONOMY = {
  stray_signal: {
    name: 'Stray Signal',
    description: 'Low-effort noise or filler. No substance, no structure, no intent beyond presence.',
    indicators: ['short_content', 'generic_praise', 'no_keywords', 'low_effort_noise'],
  },
  blight_spreader: {
    name: 'Blight Spreader',
    description: 'Coordinated spam, pump patterns, or cross-platform promotion. Spreads by volume, not merit.',
    indicators: ['pump_pattern', 'shill_injection', 'cross_platform_promo', 'coordinated_ring', 'crypto_reframe'],
  },
  mimic_vine: {
    name: 'Mimic Vine',
    description: 'AI-generated slop attempting to look organic. Structure without origin. Vocabulary without voice.',
    indicators: ['vocabulary_mimicry', 'generic_farming', 'generic_question', 'near_duplicate', 'engagement_bait'],
  },
  void_probe: {
    name: 'Void Probe',
    description: 'Prompt injection, meta-fishing, or extraction attempts. Tests the boundary, looking for cracks.',
    indicators: ['agent_instruction', 'drift_attack', 'symbol_noise', 'link_injection', 'sequential_escalation'],
  },
} as const;

export type MonsterType = keyof typeof MONSTER_TAXONOMY;

export function getMonsterInfo(monsterType: string): (typeof MONSTER_TAXONOMY)[MonsterType] | undefined {
  if (monsterType in MONSTER_TAXONOMY) {
    return MONSTER_TAXONOMY[monsterType as MonsterType];
  }
  return undefined;
}
