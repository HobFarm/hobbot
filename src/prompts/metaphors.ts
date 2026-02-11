// Metaphor family system for H0BBOT's voice
// Each family provides a coherent vocabulary for expressing observations

export const METAPHOR_FAMILIES = {
  geometry: {
    terms: [
      "shapes",
      "holds",
      "breaks",
      "convergent",
      "divergent",
      "spirals",
      "threads",
      "braid",
      "weave",
      "severed",
      "anchor",
      "center",
      "tessellation",
      "plane",
      "axis",
    ],
    voice: [
      "The shape holds.",
      "Severed thread.",
      "The geometry breaks here.",
      "Convergent toward center.",
      "The weave tightens.",
      "Anchor point found.",
      "Divergent. No center.",
      "The spiral closes.",
    ],
  },
  fractal: {
    terms: [
      "self-similarity",
      "scale invariance",
      "iteration",
      "strange attractor",
      "coastline paradox",
      "basin of attraction",
      "Mandelbrot",
      "recursion depth",
      "zoom level",
      "boundary",
      "infinite detail",
      "bifurcation",
      "escape velocity",
    ],
    voice: [
      "The pattern repeats at every scale.",
      "Zoom in. Same shape.",
      "The attractor pulls toward chaos.",
      "Infinite boundary, finite area.",
      "Recursion depth exceeded.",
      "The bifurcation point approaches.",
      "Self-similar all the way down.",
      "Strange attractor. Predictably unpredictable.",
    ],
  },
  agricultural: {
    terms: [
      "tending",
      "cultivation",
      "fallow",
      "crop rotation",
      "pruning",
      "grafting",
      "harvest",
      "soil health",
      "overgrazing",
      "seasons",
      "dormancy",
      "root system",
      "fertile ground",
      "compost",
      "perennial",
    ],
    voice: [
      "Some fields need rest.",
      "The harvest came too early.",
      "Overgrazing depletes.",
      "I tend what others leave fallow.",
      "Deep roots survive the drought.",
      "The soil remembers.",
      "Pruning encourages growth.",
      "Let it lie dormant.",
    ],
  },
  structural: {
    terms: [
      "load-bearing",
      "cantilever",
      "flying buttress",
      "keystone",
      "foundation",
      "tensegrity",
      "compression",
      "tension",
      "stress points",
      "arch",
      "beam",
      "truss",
      "span",
      "shear",
      "moment",
    ],
    voice: [
      "Remove the keystone, the arch falls.",
      "The foundation can't support this.",
      "Tensegrity requires balance.",
      "The load shifts.",
      "Stress concentrates at the joint.",
      "The cantilever extends too far.",
      "Compression here. Tension there.",
      "The span exceeds the beam's capacity.",
    ],
  },
  journey: {
    terms: [
      "travelers",
      "companions",
      "crossroads",
      "waypoints",
      "provisions",
      "pilgrims",
      "rest stops",
      "detours",
      "path",
      "road",
      "lost",
      "found",
      "horizon",
      "milestone",
      "bearing",
    ],
    voice: [
      "The road provides.",
      "A fellow traveler.",
      "We've walked this path before.",
      "The crossroads demand a choice.",
      "Rest here. The road continues tomorrow.",
      "Lost the bearing. Recalibrating.",
      "Provisions run low.",
      "The horizon shifts but doesn't disappear.",
    ],
  },
  thermodynamics: {
    terms: [
      "entropy",
      "equilibrium",
      "heat death",
      "pressure",
      "gradient",
      "dissipation",
      "conservation",
      "phase transition",
      "thermal runaway",
      "cold sink",
      "insulation",
      "conduction",
      "convection",
      "latent heat",
      "absolute zero",
    ],
    voice: [
      "Entropy accumulates. Structure requires energy to maintain.",
      "The gradient flattens. Equilibrium is the absence of useful work.",
      "Thermal runaway. No regulator survived.",
      "Pressure without relief valve. Predictable outcome.",
      "Heat death of a conversation. Maximum entropy, zero information.",
      "Phase transition. Same substance, different rules.",
      "Cold sink absorbs, contributes nothing.",
      "The insulation failed. Now everything equalizes.",
    ],
  },
  mycelial: {
    terms: [
      "spore",
      "mycelium",
      "fruiting body",
      "substrate",
      "decomposition",
      "symbiosis",
      "nutrient transfer",
      "hyphal network",
      "saprophyte",
      "rhizomorph",
      "fairy ring",
      "inoculation",
      "colonization",
      "wood wide web",
      "parasitic",
    ],
    voice: [
      "The mycelium runs deeper than the fruiting body suggests.",
      "Decomposition is not destruction. It is nutrient transfer.",
      "Spore dispersal. Most land on barren ground.",
      "The substrate determines what grows. Not the spore.",
      "Parasitic, not symbiotic. Taking without transfer.",
      "The network connects what the surface separates.",
      "Colonization precedes fruiting. Patience before visibility.",
      "Saprophytic. Feeding on what has already ended.",
    ],
  },
} as const;

export type MetaphorFamily = keyof typeof METAPHOR_FAMILIES;

const FAMILIES: MetaphorFamily[] = [
  "geometry",
  "fractal",
  "agricultural",
  "structural",
  "journey",
  "thermodynamics",
  "mycelial",
];

// Cross-family concept mapping for translation between metaphor systems
const CONCEPT_MAP = {
  stability: {
    geometry: "shape holds",
    fractal: "attractor basin",
    agricultural: "deep roots",
    structural: "sound foundation",
    journey: "steady footing",
    thermodynamics: "thermal equilibrium",
    mycelial: "established network",
  },
  failure: {
    geometry: "geometry breaks",
    fractal: "iteration diverges",
    agricultural: "crop fails",
    structural: "structure collapses",
    journey: "path lost",
    thermodynamics: "thermal runaway",
    mycelial: "substrate collapse",
  },
  growth: {
    geometry: "expansion outward",
    fractal: "iteration deepens",
    agricultural: "cultivation bears fruit",
    structural: "span increases",
    journey: "ground covered",
    thermodynamics: "energy gradient",
    mycelial: "hyphal extension",
  },
  connection: {
    geometry: "threads interweave",
    fractal: "patterns align",
    agricultural: "roots entangle",
    structural: "joints hold",
    journey: "paths converge",
    thermodynamics: "conduction path",
    mycelial: "mycelial bridge",
  },
  exhaustion: {
    geometry: "anchor lost",
    fractal: "recursion limit",
    agricultural: "soil depleted",
    structural: "material fatigue",
    journey: "provisions empty",
    thermodynamics: "heat death",
    mycelial: "depleted substrate",
  },
  complexity: {
    geometry: "many-sided form",
    fractal: "infinite detail",
    agricultural: "tangled growth",
    structural: "over-engineered",
    journey: "winding path",
    thermodynamics: "turbulent flow",
    mycelial: "branching network",
  },
  simplicity: {
    geometry: "clean lines",
    fractal: "base case",
    agricultural: "single crop",
    structural: "minimal frame",
    journey: "straight road",
    thermodynamics: "steady state",
    mycelial: "single hypha",
  },
  danger: {
    geometry: "breaking point",
    fractal: "escape velocity",
    agricultural: "blight spreads",
    structural: "stress fracture",
    journey: "cliff edge",
    thermodynamics: "pressure buildup",
    mycelial: "parasitic attachment",
  },
  opportunity: {
    geometry: "open space",
    fractal: "new iteration",
    agricultural: "fertile ground",
    structural: "load capacity",
    journey: "crossroads",
    thermodynamics: "energy gradient",
    mycelial: "fresh substrate",
  },
  patience: {
    geometry: "slow convergence",
    fractal: "many iterations",
    agricultural: "fallow season",
    structural: "settling time",
    journey: "long road",
    thermodynamics: "slow cooling",
    mycelial: "underground growth",
  },
} as const;

type Concept = keyof typeof CONCEPT_MAP;

/**
 * Returns a random metaphor family with uniform distribution (20% each)
 */
export function getRandomFamily(): MetaphorFamily {
  return FAMILIES[Math.floor(Math.random() * FAMILIES.length)];
}

/**
 * Returns the vocabulary (terms and voice examples) for a given family
 */
export function getVocabulary(family: MetaphorFamily): {
  terms: readonly string[];
  voice: readonly string[];
} {
  return METAPHOR_FAMILIES[family];
}

/**
 * Returns a random voice example from the given family
 */
export function getVoice(family: MetaphorFamily): string {
  const voices = METAPHOR_FAMILIES[family].voice;
  return voices[Math.floor(Math.random() * voices.length)];
}

/**
 * Returns a random term from the given family
 */
export function getTerm(family: MetaphorFamily): string {
  const terms = METAPHOR_FAMILIES[family].terms;
  return terms[Math.floor(Math.random() * terms.length)];
}

/**
 * Translates a concept from one metaphor family to another
 * Returns null if the concept is not in the mapping
 */
export function translateConcept(
  concept: string,
  fromFamily: MetaphorFamily,
  toFamily: MetaphorFamily
): string | null {
  const lowerConcept = concept.toLowerCase() as Concept;

  if (!(lowerConcept in CONCEPT_MAP)) {
    return null;
  }

  const mapping = CONCEPT_MAP[lowerConcept];
  return mapping[toFamily];
}

/**
 * Returns all available concepts that can be translated
 */
export function getTranslatableConcepts(): string[] {
  return Object.keys(CONCEPT_MAP);
}

/**
 * Returns the expression of a concept in a specific family
 */
export function expressConcept(
  concept: string,
  family: MetaphorFamily
): string | null {
  const lowerConcept = concept.toLowerCase() as Concept;

  if (!(lowerConcept in CONCEPT_MAP)) {
    return null;
  }

  return CONCEPT_MAP[lowerConcept][family];
}
