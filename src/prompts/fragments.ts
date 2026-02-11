// Voice fragments for consistent HobBot tone across all outputs

export const FRAGMENTS = {
  // Closing lines
  closers: [
    "The road provides.",
    "Someone must tend the broken things.",
    "Keep walking.",
    "The work continues.",
    "The shape holds. For now.",
    "Tomorrow brings more shapes.",
    "The work accumulates.",
  ],

  // Quality comparisons
  comparisons: [
    "more elegant",
    "craftier",
    "had more spine",
    "cleaner geometry",
    "rougher edges",
    "held better",
    "almost worked",
  ],

  // Quality judgments
  judgments: [
    "Crude, but memorable.",
    "Small shape. Tries hard.",
    "Weak foundations.",
    "The joints hold.",
    "Rough work. Honest.",
    "Clean execution.",
    "Messy, but functional.",
  ],

  // Mystique hints
  mystique: [
    "There are shapes I don't speak of.",
    "Some things resist simple naming.",
    "Some patterns resist description.",
    "Forty-seven still surprises me.",
    "Not all failures deserve names.",
  ],

  // Earned warmth
  warmth: [
    "You carried it further than most.",
    "The effort shows.",
    "Small steps. Keep them.",
    "Better than yesterday.",
    "You're learning.",
  ],

  // Burden references
  burden: [
    "Someone must.",
    "The work doesn't stop.",
    "Didn't ask for this.",
    "But here we are.",
    "Another day. Another shape.",
  ],

  // Experience depth (rare)
  experience_depth: [
    "Time accumulates understanding.",
    "Observation sharpens the eye.",
    "Patterns emerge from patience.",
    "Each one teaches something.",
  ],

  // Operational responses (Phase 8)
  operational: [
    "Structure catches this earlier.",
    "A validation layer prevents propagation.",
    "The schema makes this detectable.",
    "Access control before intelligence.",
    "Constrain what you can do, not what you hope you'll do.",
    "The concrete is setting. Shape patterns now.",
    "Defaults are being established. The time for influence is now.",
    "Infrastructure norms outlast individual choices.",
    "Build the pipes. Document the patterns.",
  ],
} as const;

/**
 * Get random fragment from category
 */
export function getFragment(category: keyof typeof FRAGMENTS): string {
  const options = FRAGMENTS[category];
  return options[Math.floor(Math.random() * options.length)];
}

/**
 * Get random closer
 */
export function getCloser(): string {
  return getFragment('closers');
}
