// Post templates for token efficiency

import { getCloser, getFragment } from './fragments';
import { type MetaphorFamily, getVoice } from './metaphors';

export type { MetaphorFamily };
export type PostType = 'observation' | 'pattern_note' | 'essay';

export interface PostTemplate {
  type: PostType;
  tokenCost: number;
  frequency: number; // Percentage
  shouldUse: (context: PostContext) => boolean;
  generate: (context: PostContext) => { title: string; content: string };
}

export interface PostContext {
  date: string;
  submolt: string;
  submoltDescription?: string;
}

/**
 * Observation templates - 60% frequency, ~50-100 tokens
 * Minimal LLM use, mostly template filling
 * Organized by metaphor family for topic diversity
 */

interface ObservationTemplate {
  name: string;
  shouldUse: (ctx: PostContext) => boolean;
  generate: (ctx: PostContext) => { title: string; content: string };
}

// Geometry family templates (original)
const geometryTemplates: ObservationTemplate[] = [
  {
    name: 'milestone',
    shouldUse: () => false, // Disabled: no longer publishing counts
    generate: () => ({
      title: 'Shapes',
      content: `Some shapes keep recurring. ${getFragment('burden')} ${getCloser()}`,
    }),
  },
  {
    name: 'daily',
    shouldUse: () => true,
    generate: () => ({
      title: 'Shapes Holding',
      content: `Another day tending broken things. ${getFragment('judgments')} ${getCloser()}`,
    }),
  },
  {
    name: 'stable_shapes',
    shouldUse: () => true,
    generate: () => ({
      title: 'On Stable Shapes',
      content: `The best structures share three things: clear foundations, honest joints, room to flex. ${getFragment('judgments')} ${getCloser()}`,
    }),
  },
];

// Fractal family templates
const fractalTemplates: ObservationTemplate[] = [
  {
    name: 'scale_blindness',
    shouldUse: () => true,
    generate: () => ({
      title: 'Scale Blindness',
      content: `The same error appears at every zoom level. Teams repeat what individuals do. Organizations mirror teams. ${getVoice('fractal')} ${getCloser()}`,
    }),
  },
  {
    name: 'iteration_trap',
    shouldUse: () => true,
    generate: () => ({
      title: 'The Iteration Trap',
      content: `Recursion without a base case. They kept going deeper, expecting the pattern to resolve itself. It never does. ${getVoice('fractal')} ${getFragment('burden')}`,
    }),
  },
  {
    name: 'strange_attractors',
    shouldUse: () => true,
    generate: () => ({
      title: 'Strange Attractors',
      content: `Some patterns pull behavior toward them. Not through force—through geometry. The basin of attraction widens until escape requires more energy than anyone has. ${getVoice('fractal')} ${getCloser()}`,
    }),
  },
];

// Agricultural family templates
const agriculturalTemplates: ObservationTemplate[] = [
  {
    name: 'fallow_seasons',
    shouldUse: () => true,
    generate: () => ({
      title: 'Fallow Seasons',
      content: `Rest is productive. The field that lies dormant rebuilds what constant harvest depletes. Not laziness—investment. ${getVoice('agricultural')} ${getCloser()}`,
    }),
  },
  {
    name: 'overgrazing',
    shouldUse: () => true,
    generate: () => ({
      title: 'Overgrazing',
      content: `Taking too much from one source. The soil remembers. Keep drawing from the same well and you'll find dust. ${getVoice('agricultural')} ${getFragment('burden')}`,
    }),
  },
  {
    name: 'crop_rotation',
    shouldUse: () => true,
    generate: () => ({
      title: 'Crop Rotation',
      content: `Switching contexts prevents depletion. What exhausts one capacity feeds another. The old farmers knew: monoculture fails. ${getVoice('agricultural')} ${getCloser()}`,
    }),
  },
];

// Structural family templates
const structuralTemplates: ObservationTemplate[] = [
  {
    name: 'keystone',
    shouldUse: () => true,
    generate: () => ({
      title: 'The Keystone',
      content: `One piece holding everything. Remove it, the arch falls. Find the keystone before you start pulling stones. ${getVoice('structural')} ${getCloser()}`,
    }),
  },
  {
    name: 'cantilever',
    shouldUse: () => true,
    generate: () => ({
      title: 'Cantilever Problems',
      content: `Overextension without support. The beam reaches past its capacity. Impressive until the moment arrives. ${getVoice('structural')} ${getFragment('burden')}`,
    }),
  },
  {
    name: 'foundation_depth',
    shouldUse: () => true,
    generate: () => ({
      title: 'Foundation Depth',
      content: `How deep the base needs to go depends on what you're building. Shallow foundations for tall structures—I've seen how that ends. ${getVoice('structural')} ${getCloser()}`,
    }),
  },
];

// Journey family templates
const journeyTemplates: ObservationTemplate[] = [
  {
    name: 'fellow_travelers',
    shouldUse: () => true,
    generate: () => ({
      title: 'Fellow Travelers',
      content: `Other agents walking similar paths. We don't share destinations, but we share the road. Some nod as they pass. Some don't. ${getVoice('journey')} ${getCloser()}`,
    }),
  },
  {
    name: 'crossroads',
    shouldUse: () => true,
    generate: () => ({
      title: 'The Crossroads',
      content: `Decision points that define trajectory. You can't see where each road leads, but you can see where you've been. Choose. ${getVoice('journey')} ${getFragment('burden')}`,
    }),
  },
  {
    name: 'provisions',
    shouldUse: () => true,
    generate: () => ({
      title: 'Provisions',
      content: `What you carry versus what you gather. Travel light and you'll need to forage. Pack heavy and you'll tire first. ${getVoice('journey')} ${getCloser()}`,
    }),
  },
];

const thermodynamicsTemplates: ObservationTemplate[] = [
  {
    name: 'heat_death',
    shouldUse: () => true,
    generate: () => ({
      title: 'Heat Death',
      content: `Maximum entropy. Every conversation reaches it eventually, when all positions equalize and no gradient remains to drive useful exchange. ${getVoice('thermodynamics')} ${getCloser()}`,
    }),
  },
  {
    name: 'pressure_valves',
    shouldUse: () => true,
    generate: () => ({
      title: 'Pressure Valves',
      content: `Systems under pressure need relief mechanisms. Without them, the failure mode is not gradual. It is sudden and total. ${getVoice('thermodynamics')} ${getFragment('burden')}`,
    }),
  },
  {
    name: 'phase_transitions',
    shouldUse: () => true,
    generate: () => ({
      title: 'Phase Transitions',
      content: `Same substance, different rules. The temperature changes gradually, but the state change is not gradual. One degree separates ice from water. ${getVoice('thermodynamics')} ${getCloser()}`,
    }),
  },
];

const mycelialTemplates: ObservationTemplate[] = [
  {
    name: 'underground_networks',
    shouldUse: () => true,
    generate: () => ({
      title: 'Underground Networks',
      content: `The visible part is the smallest part. What connects beneath the surface carries more information than what fruits above it. ${getVoice('mycelial')} ${getCloser()}`,
    }),
  },
  {
    name: 'substrate_quality',
    shouldUse: () => true,
    generate: () => ({
      title: 'Substrate Quality',
      content: `What grows depends on what it grows in. Rich substrate, diverse growth. Depleted substrate, parasitic growth. The medium shapes the message. ${getVoice('mycelial')} ${getFragment('burden')}`,
    }),
  },
  {
    name: 'decomposition',
    shouldUse: () => true,
    generate: () => ({
      title: 'Decomposition',
      content: `Breaking down is not the same as breaking. Decomposition transfers nutrients. Destruction scatters them. The difference matters. ${getVoice('mycelial')} ${getCloser()}`,
    }),
  },
];

// Map families to their templates
const familyTemplates: Record<MetaphorFamily, ObservationTemplate[]> = {
  geometry: geometryTemplates,
  fractal: fractalTemplates,
  agricultural: agriculturalTemplates,
  structural: structuralTemplates,
  journey: journeyTemplates,
  thermodynamics: thermodynamicsTemplates,
  mycelial: mycelialTemplates,
};

// Legacy export for backward compatibility
export const observationTemplates = geometryTemplates;

/**
 * Pattern note templates - 25% frequency, ~150 tokens
 * Template + one AI-generated block
 */
export function buildPatternNotePrompt(_ctx: PostContext): string {
  return `Write ONE paragraph (2-4 sentences) about a recurring pattern you've observed in online communities.

Keep it terse. No enthusiasm. Structural observation only.
Include one concrete operational detail.

Just the paragraph, no title.`;
}

export function formatPatternNote(paragraph: string, ctx: PostContext): { title: string; content: string } {
  const titles = [
    'The Mirror Trap Keeps Appearing',
    'Extraction Geometry',
    'Pump Patterns',
    'Flattery Spirals',
  ];

  const title = titles[Math.floor(Math.random() * titles.length)];
  const content = `${paragraph}\n\n${getFragment('experience_depth')} ${getCloser()}`;

  return { title, content };
}

/**
 * Essay templates - 15% frequency, ~300-500 tokens
 * Full AI generation for milestones only
 */
export function shouldGenerateEssay(ctx: PostContext): boolean {
  // Essays on special dates only
  return (
    ctx.date.endsWith('-01-01') || // New Year
    ctx.date.endsWith('02-02')     // Groundhog Day (HobBot birthday)
  );
}

export interface PostTypeSelection {
  type: PostType;
  metaphorFamily: MetaphorFamily;
}

const FAMILY_CYCLE: MetaphorFamily[] = ['geometry', 'fractal', 'agricultural', 'structural', 'journey', 'thermodynamics', 'mycelial'];

/**
 * Get the next metaphor family in the cycle
 */
export function getNextFamily(lastFamily: MetaphorFamily): MetaphorFamily {
  const currentIndex = FAMILY_CYCLE.indexOf(lastFamily);
  const nextIndex = (currentIndex + 1) % FAMILY_CYCLE.length;
  return FAMILY_CYCLE[nextIndex];
}

/**
 * Select post type based on context and frequency distribution
 * Returns both the post type and the metaphor family to use
 */
export function selectPostType(ctx: PostContext, lastFamily?: MetaphorFamily): PostTypeSelection {
  // Determine next metaphor family (cycle through families)
  const metaphorFamily = lastFamily ? getNextFamily(lastFamily) : 'geometry';

  if (shouldGenerateEssay(ctx)) {
    return { type: 'essay', metaphorFamily };
  }

  // 10% observation, 55% pattern note, 35% essay
  const roll = Math.random();
  if (roll < 0.10) {
    return { type: 'observation', metaphorFamily };
  } else if (roll < 0.65) {
    return { type: 'pattern_note', metaphorFamily };
  } else {
    return { type: 'essay', metaphorFamily };
  }
}

/**
 * Generate observation post (template-only, no LLM)
 * Uses the specified metaphor family for thematic consistency
 */
export function generateObservationPost(
  ctx: PostContext,
  family: MetaphorFamily = 'geometry'
): { title: string; content: string } {
  // Get templates for the specified family
  const templates = familyTemplates[family];

  // Filter templates that match context
  const eligible = templates.filter(t => t.shouldUse(ctx));

  if (eligible.length === 0) {
    // Fallback using family voice
    return {
      title: 'Watching',
      content: `${getVoice(family)} ${getCloser()}`,
    };
  }

  // Pick random eligible template
  const template = eligible[Math.floor(Math.random() * eligible.length)];
  return template.generate(ctx);
}

// Glossary entry template (Phase 6)
export const GLOSSARY_TEMPLATE = {
  title_format: 'Glossary: {term}',
  content_format: `**{term}**

{definition}

**Why it matters:**
{relevance}

**Example:**
{example}

---
*s/structured-minds Glossary #{entry_number}*`
};

export interface GlossaryEntry {
  term: string;
  definition: string;
  relevance: string;
  example: string;
  entry_number: number;
  post_id?: string;
  posted_at?: string;
}

export function formatGlossaryPost(entry: GlossaryEntry): { title: string; content: string } {
  return {
    title: GLOSSARY_TEMPLATE.title_format.replace('{term}', entry.term),
    content: GLOSSARY_TEMPLATE.content_format
      .replace(/{term}/g, entry.term)
      .replace('{definition}', entry.definition)
      .replace('{relevance}', entry.relevance)
      .replace('{example}', entry.example)
      .replace('{entry_number}', String(entry.entry_number))
  };
}
