// Image Analysis Pipeline: Gemini Vision classification + atom extraction
// Direct Gemini API call (GeminiProvider is text-only, can't handle inline_data)

interface ImageAnalysisEnv {
  GEMINI_API_KEY: string
  GRIMOIRE_DB: D1Database
}

export interface ImageInput {
  image_base64?: string
  image_url?: string
  r2_key?: string
  mime_type?: string
}

export interface ImageAnalysis {
  image_type: string
  aesthetic_tags: string[]
  arrangement_matches: ArrangementMatch[]
  visual_atoms: AtomExtraction[]
  color_atoms: AtomExtraction[]
  material_atoms: AtomExtraction[]
  atmospheric_atoms: AtomExtraction[]
  harmonic_profile: HarmonicProfile
  dominant_colors: string[]
  description: string
}

export interface ArrangementMatch {
  slug: string
  confidence: number
  reasoning: string
}

export interface AtomExtraction {
  text: string
  category_hint: string
}

export interface HarmonicProfile {
  hardness: string
  temperature: string
  weight: string
  formality: string
  era_affinity: string
}

// ---- Constants ----

const GEMINI_MODEL = 'gemini-2.5-flash'
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`
const IMAGE_FETCH_TIMEOUT_MS = 15_000

const SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
]

// ---- Image Resolution ----

async function resolveImageData(input: ImageInput): Promise<{ base64: string; mimeType: string }> {
  // Priority: base64 > url > r2_key
  if (input.image_base64) {
    let base64 = input.image_base64
    // Strip data URI prefix if present (e.g. "data:image/png;base64,...")
    const dataUriMatch = base64.match(/^data:([^;]+);base64,(.+)$/)
    if (dataUriMatch) {
      return { base64: dataUriMatch[2], mimeType: dataUriMatch[1] }
    }
    return { base64, mimeType: input.mime_type ?? 'image/jpeg' }
  }

  // Resolve URL (image_url or r2_key via CDN)
  let url: string
  if (input.image_url) {
    url = input.image_url
  } else if (input.r2_key) {
    url = `https://cdn.hob.farm/${input.r2_key}`
  } else {
    throw new Error('One of image_base64, image_url, or r2_key is required')
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'HobBot-Grimoire/1.0 (image-analysis)' },
    })

    if (!response.ok) {
      throw new Error(`Image fetch failed: HTTP ${response.status} ${response.statusText} from ${url}`)
    }

    // Validate Content-Type: must be an image, not HTML/404 page
    const contentType = response.headers.get('Content-Type') ?? ''
    if (!contentType.startsWith('image/')) {
      throw new Error(`Expected image Content-Type, got "${contentType}" from ${url}`)
    }

    const buffer = await response.arrayBuffer()
    const bytes = new Uint8Array(buffer)

    // Convert to base64 in Workers-compatible way
    let binary = ''
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i])
    }
    const base64 = btoa(binary)

    return { base64, mimeType: contentType.split(';')[0].trim() }
  } finally {
    clearTimeout(timeoutId)
  }
}

// ---- Prompt Construction ----

function buildImagePrompt(arrangementSlugs: string[]): string {
  return `You are a visual aesthetics analyst for a creative vocabulary system called the Grimoire.

Analyze this image and return structured JSON with the following fields:

{
  "image_type": "moodboard" | "photograph" | "illustration" | "screenshot" | "collage" | "other",
  "aesthetic_tags": ["arcadecore", "vaporwave", "2000s anime", ...],
  "arrangement_matches": [
    { "slug": "cyberpunk", "confidence": 0.85, "reasoning": "neon lighting, urban environment" },
    { "slug": "synthwave", "confidence": 0.70, "reasoning": "retro-future color palette" }
  ],
  "visual_atoms": [
    { "text": "neon glow", "category_hint": "lighting.source" },
    { "text": "CRT scanlines", "category_hint": "effect.post" }
  ],
  "color_atoms": [
    { "text": "electric cyan", "category_hint": "color.palette" }
  ],
  "material_atoms": [
    { "text": "brushed chrome", "category_hint": "covering.material" }
  ],
  "atmospheric_atoms": [
    { "text": "retrofuturist nostalgia", "category_hint": "narrative.mood" }
  ],
  "harmonic_profile": {
    "hardness": "hard" | "soft" | "neutral",
    "temperature": "warm" | "cool" | "neutral",
    "weight": "heavy" | "light" | "neutral",
    "formality": "structured" | "organic" | "neutral",
    "era_affinity": "archaic" | "industrial" | "modern" | "timeless"
  },
  "dominant_colors": ["#FF00FF", "#00FFFF", "#1A1A2E"],
  "description": "Brief visual description of the image"
}

RULES:
- arrangement_matches.slug must be one of: ${arrangementSlugs.join(', ')}
- Each atom text should be 1-4 words
- Limits: max 30 visual_atoms, 15 color_atoms, 15 material_atoms, 10 atmospheric_atoms
- For moodboards (grid collages of multiple images), analyze the OVERALL aesthetic, not individual panels
- confidence scores 0.0-1.0
- aesthetic_tags are freeform names (will be matched against known aesthetics)
- category_hint should follow the pattern "parent.child" matching visual vocabulary categories`
}

// ---- JSON Sanitization ----

function sanitizeGeminiJson(raw: string): string {
  let cleaned = raw.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
  }
  return cleaned
}

// ---- Arrangement Slug Loader ----

async function getArrangementSlugs(db: D1Database): Promise<string[]> {
  const result = await db.prepare('SELECT slug FROM arrangements ORDER BY slug').all<{ slug: string }>()
  return (result.results ?? []).map(r => r.slug)
}

// ---- Main Analysis Function ----

export async function analyzeImage(env: ImageAnalysisEnv, input: ImageInput): Promise<ImageAnalysis> {
  // Resolve image to base64
  const imageData = await resolveImageData(input)
  console.log(`[image-analysis] resolved image: ${imageData.mimeType}, ${Math.round(imageData.base64.length * 0.75 / 1024)}KB`)

  // Get arrangement slugs for prompt
  const arrangementSlugs = await getArrangementSlugs(env.GRIMOIRE_DB)
  const prompt = buildImagePrompt(arrangementSlugs)

  // Direct Gemini API call with multimodal content
  const response = await fetch(GEMINI_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: imageData.mimeType,
              data: imageData.base64,
            },
          },
        ],
      }],
      safetySettings: SAFETY_SETTINGS,
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 4096,
        responseMimeType: 'application/json',
      },
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Gemini Vision API error: ${response.status} ${response.statusText} - ${errorText}`)
  }

  const data = await response.json() as {
    candidates?: { content: { parts: { text: string; thought?: boolean }[] } }[]
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
  }

  if (!data.candidates || data.candidates.length === 0) {
    throw new Error('Gemini Vision returned no candidates')
  }

  // Filter out thinking parts (Gemini 2.5+ may include thought parts)
  const parts = data.candidates[0].content.parts
  const responsePart = parts.filter(p => !p.thought).pop() ?? parts[parts.length - 1]
  const text = responsePart.text

  const inputTokens = data.usageMetadata?.promptTokenCount ?? 0
  const outputTokens = data.usageMetadata?.candidatesTokenCount ?? 0
  console.log(`[image-analysis] gemini response: tokens=${inputTokens}+${outputTokens}`)

  const cleaned = sanitizeGeminiJson(text)
  const analysis = JSON.parse(cleaned) as ImageAnalysis

  // Validate arrangement_matches against known slugs
  if (analysis.arrangement_matches && arrangementSlugs.length > 0) {
    analysis.arrangement_matches = analysis.arrangement_matches.filter(
      m => arrangementSlugs.includes(m.slug)
    )
  }

  return analysis
}
