/**
 * Artificial Analysis API client — fetches model benchmark and quality data.
 *
 * API: GET https://artificialanalysis.ai/api/v2/data/llms/models
 * Auth: x-api-key header (free tier, 1000 req/day)
 * Cache: R2 with 24h TTL
 *
 * Provides intelligence scores, benchmark results, speed, and pricing
 * that enrich our curated model catalog with objective quality data.
 */

// === API Response Types (matches actual AA API v2 response) ===

/** Raw model entry from the Artificial Analysis API v2. */
export interface AAApiModel {
  id: string;
  name: string;
  slug: string;
  model_creator: {
    id: string;
    name: string;
    slug: string;
  };
  evaluations?: {
    artificial_analysis_intelligence_index?: number;
    artificial_analysis_coding_index?: number;
    artificial_analysis_math_index?: number;
    mmlu_pro?: number;
    gpqa?: number;
    hle?: number;
    livecodebench?: number;
    scicode?: number;
    math_500?: number;
    aime?: number;
  };
  pricing?: {
    price_1m_blended_3_to_1?: number;
    price_1m_input_tokens?: number;
    price_1m_output_tokens?: number;
  };
  median_output_tokens_per_second?: number;
  median_time_to_first_token_seconds?: number;
}

/** API response wrapper. */
interface AAApiResponse {
  status: number;
  data: AAApiModel[];
  prompt_options?: unknown;
}

/** Processed benchmark data for a single model, stored in R2 cache. */
export interface AABenchmarkData {
  /** AA Intelligence Index (0-100 composite score) */
  intelligenceIndex: number;
  /** AA Coding Index */
  codingScore?: number;
  /** AA Math Index */
  mathScore?: number;
  /** MMLU-Pro score */
  mmluPro?: number;
  /** GPQA Diamond score */
  gpqa?: number;
  /** LiveCodeBench score */
  livecodebench?: number;
  /** Median output tokens/sec */
  speedTps?: number;
  /** Time to first token in seconds */
  ttftSec?: number;
  /** Blended cost per million tokens */
  blendedCostPerM?: number;
  /** Raw creator name from AA */
  aaCreator: string;
  /** Raw model name from AA */
  aaModelName: string;
  /** AA slug (stable identifier) */
  aaSlug: string;
}

// Re-export for backward compatibility
export type AAModelEntry = AAApiModel;

/** R2-cached benchmark catalog. */
export interface AABenchmarkCatalog {
  version: number;
  fetchedAt: number;
  /** Keyed by normalized model identifier (lowercase) */
  models: Record<string, AABenchmarkData>;
  totalFetched: number;
}

export const AA_CATALOG_VERSION = 2;
export const AA_CATALOG_R2_KEY = 'sync/aa-benchmarks.json';
/** Cache TTL: 24 hours */
export const AA_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const AA_API_URL = 'https://artificialanalysis.ai/api/v2/data/llms/models';

// === API Fetching ===

/**
 * Fetch model benchmark data from Artificial Analysis API.
 */
export async function fetchAABenchmarks(apiKey: string): Promise<AAApiModel[]> {
  const response = await fetch(AA_API_URL, {
    headers: { 'x-api-key': apiKey },
  });

  if (!response.ok) {
    throw new Error(`Artificial Analysis API returned HTTP ${response.status}: ${response.statusText}`);
  }

  const json = await response.json() as AAApiResponse | AAApiModel[];
  // Handle both { data: [...] } wrapper and raw array
  if (Array.isArray(json)) return json;
  if ('data' in json && Array.isArray(json.data)) return json.data;
  throw new Error('Unexpected AA API response format');
}

// === Normalization & Matching ===

/**
 * Normalize a model name for matching across AA and OpenRouter catalogs.
 * Strips parentheses, normalizes separators.
 *
 * Examples:
 *   "Claude Sonnet 4.5" → "claude-sonnet-4.5"
 *   "GPT-4o" → "gpt-4o"
 *   "DeepSeek V3.2" → "deepseek-v3.2"
 */
export function normalizeModelName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[()]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Build a lookup map from AA entries keyed by multiple name variants.
 * Returns a Map where each AA model can be found by several normalized keys.
 */
export function buildAALookup(entries: AAApiModel[]): Map<string, AABenchmarkData> {
  const lookup = new Map<string, AABenchmarkData>();

  for (const entry of entries) {
    const evals = entry.evaluations;
    // Skip entries with no useful evaluation data
    if (!evals || (evals.artificial_analysis_intelligence_index == null && evals.artificial_analysis_coding_index == null)) {
      continue;
    }

    const data: AABenchmarkData = {
      intelligenceIndex: evals.artificial_analysis_intelligence_index ?? 0,
      codingScore: evals.artificial_analysis_coding_index ?? undefined,
      mathScore: evals.artificial_analysis_math_index ?? undefined,
      mmluPro: evals.mmlu_pro ?? undefined,
      gpqa: evals.gpqa ?? undefined,
      livecodebench: evals.livecodebench ?? undefined,
      speedTps: entry.median_output_tokens_per_second ?? undefined,
      ttftSec: entry.median_time_to_first_token_seconds ?? undefined,
      blendedCostPerM: entry.pricing?.price_1m_blended_3_to_1 ?? undefined,
      aaCreator: entry.model_creator?.name ?? '',
      aaModelName: entry.name,
      aaSlug: entry.slug,
    };

    // Key 1: AA slug (stable identifier, e.g. "claude-sonnet-4-5")
    if (entry.slug) {
      lookup.set(entry.slug.toLowerCase(), data);
    }

    // Key 2: Normalized model name (e.g. "claude-sonnet-4.5")
    const nameKey = normalizeModelName(entry.name);
    if (nameKey) lookup.set(nameKey, data);

    // Key 3: creator/model-name (e.g. "anthropic/claude-sonnet-4.5")
    if (entry.model_creator?.name) {
      const creatorKey = normalizeModelName(`${entry.model_creator.name}/${entry.name}`);
      if (creatorKey) lookup.set(creatorKey, data);
    }

    // Key 4: creator-slug/model-slug (for more exact matching)
    if (entry.model_creator?.slug && entry.slug) {
      const slugKey = `${entry.model_creator.slug}/${entry.slug}`;
      lookup.set(slugKey.toLowerCase(), data);
    }
  }

  return lookup;
}

/**
 * Match an OpenRouter model ID to AA benchmark data.
 * Tries multiple matching strategies in order of confidence.
 *
 * @param modelId - OpenRouter model ID (e.g. "anthropic/claude-sonnet-4.5")
 * @param modelName - Display name (e.g. "Claude Sonnet 4.5")
 * @param aaLookup - Pre-built AA lookup map
 */
export function matchModelToAA(
  modelId: string,
  modelName: string,
  aaLookup: Map<string, AABenchmarkData>,
): AABenchmarkData | undefined {
  const idLower = modelId.toLowerCase();

  // Strategy 1: Exact model ID match (e.g. "anthropic/claude-sonnet-4.5")
  if (aaLookup.has(idLower)) return aaLookup.get(idLower);

  // Strategy 2: Normalized display name (e.g. "Claude Sonnet 4.5" → "claude-sonnet-4.5")
  const normName = normalizeModelName(modelName);
  if (aaLookup.has(normName)) return aaLookup.get(normName);

  // Strategy 3: Strip provider prefix from ID and match
  const idWithoutProvider = idLower.includes('/')
    ? idLower.split('/').slice(1).join('/')
    : idLower;
  const normId = normalizeModelName(idWithoutProvider);
  if (aaLookup.has(normId)) return aaLookup.get(normId);

  // Strategy 4: Strip :free/:nitro suffixes and version tags
  const baseId = normId
    .replace(/:free$/, '')
    .replace(/:nitro$/, '')
    .replace(/-preview$/, '')
    .replace(/-\d{4}$/, ''); // Strip date suffixes like -0528
  if (baseId !== normId && aaLookup.has(baseId)) return aaLookup.get(baseId);

  // Strategy 5: Dots to hyphens (AA slugs use hyphens: "claude-sonnet-4-5" vs our "claude-sonnet-4.5")
  const dotToHyphen = baseId.replace(/\./g, '-');
  if (dotToHyphen !== baseId && aaLookup.has(dotToHyphen)) return aaLookup.get(dotToHyphen);

  // Strategy 5b: Strip variant suffixes (-fast, -mini, -turbo, etc.) and retry
  const variantStripped = dotToHyphen
    .replace(/-(fast|turbo|mini|small|large|latest|online|chat|instruct|hq)$/, '');
  if (variantStripped !== dotToHyphen && aaLookup.has(variantStripped)) return aaLookup.get(variantStripped);

  // Strategy 6: Try with provider from model ID
  if (idLower.includes('/')) {
    const provider = idLower.split('/')[0];
    // Try provider-slug/model-slug
    const providerSlug = provider.replace(/ai$/, '').replace(/-?llama$/, '');
    const withProvider = `${providerSlug}/${dotToHyphen}`;
    if (aaLookup.has(withProvider)) return aaLookup.get(withProvider);
  }

  // Strategy 7: Fuzzy prefix match — find AA entries starting with our base
  for (const [key, data] of aaLookup) {
    if (key.startsWith(baseId) && key.length - baseId.length <= 8) {
      return data;
    }
    // Also try dot-to-hyphen variant
    if (dotToHyphen !== baseId && key.startsWith(dotToHyphen) && key.length - dotToHyphen.length <= 8) {
      return data;
    }
  }

  return undefined;
}

// === R2 Cache ===

/**
 * Fetch AA benchmarks and cache to R2. Returns cached data if fresh.
 */
export async function fetchAndCacheAABenchmarks(
  bucket: R2Bucket,
  apiKey: string,
  forceRefresh = false,
): Promise<AABenchmarkCatalog | null> {
  // Check cache first
  if (!forceRefresh) {
    const cached = await loadAABenchmarks(bucket);
    if (cached && (Date.now() - cached.fetchedAt) < AA_CACHE_TTL_MS) {
      console.log(`[AA] Using cached benchmarks (${Object.keys(cached.models).length} models, age ${Math.round((Date.now() - cached.fetchedAt) / 3600000)}h)`);
      return cached;
    }
  }

  try {
    console.log('[AA] Fetching fresh benchmark data...');
    const entries = await fetchAABenchmarks(apiKey);
    const lookup = buildAALookup(entries);

    const catalog: AABenchmarkCatalog = {
      version: AA_CATALOG_VERSION,
      fetchedAt: Date.now(),
      models: Object.fromEntries(lookup),
      totalFetched: entries.length,
    };

    await bucket.put(AA_CATALOG_R2_KEY, JSON.stringify(catalog), {
      httpMetadata: { contentType: 'application/json' },
    });

    console.log(`[AA] Cached ${lookup.size} models with benchmark data (from ${entries.length} raw entries)`);
    return catalog;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[AA] Fetch failed: ${msg}`);
    // Return stale cache if available
    const stale = await loadAABenchmarks(bucket);
    if (stale) {
      console.log(`[AA] Using stale cache (age ${Math.round((Date.now() - stale.fetchedAt) / 3600000)}h)`);
      return stale;
    }
    return null;
  }
}

/**
 * Load AA benchmark catalog from R2 cache.
 */
export async function loadAABenchmarks(bucket: R2Bucket): Promise<AABenchmarkCatalog | null> {
  try {
    const obj = await bucket.get(AA_CATALOG_R2_KEY);
    if (!obj) return null;

    const data = await obj.json() as AABenchmarkCatalog;
    if (data.version !== AA_CATALOG_VERSION) {
      console.warn(`[AA] Catalog version mismatch: expected ${AA_CATALOG_VERSION}, got ${data.version}`);
      return null;
    }
    return data;
  } catch {
    console.error('[AA] Failed to parse benchmark catalog from R2');
    return null;
  }
}
