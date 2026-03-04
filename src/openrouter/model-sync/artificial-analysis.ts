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

// === API Response Types ===

/** Raw model entry from the Artificial Analysis API. */
export interface AAModelEntry {
  model_name: string;
  provider_name?: string;
  /** Composite intelligence index (0-100 scale, from 10 hard benchmarks) */
  intelligence_index?: number;
  /** Individual benchmark scores */
  coding_score?: number;
  reasoning_score?: number;
  math_score?: number;
  /** MMLU-Pro score */
  mmlu_pro?: number;
  /** GPQA Diamond score */
  gpqa_diamond?: number;
  /** Speed: median output tokens per second */
  output_tokens_per_second?: number;
  /** Time to first token in ms */
  time_to_first_token_ms?: number;
  /** Pricing per million tokens */
  input_cost_per_million?: number;
  output_cost_per_million?: number;
  /** Blended cost (input+output average) */
  blended_cost_per_million?: number;
  /** Context window */
  context_window?: number;
  /** Whether model supports tool/function calling */
  supports_tool_use?: boolean;
  /** Whether model supports vision/image input */
  supports_vision?: boolean;
  /** Model identifier slug */
  model_id?: string;
  /** Any additional fields */
  [key: string]: unknown;
}

/** Processed benchmark data for a single model, stored in R2 cache. */
export interface AABenchmarkData {
  /** AA Intelligence Index (0-100) */
  intelligenceIndex: number;
  /** Coding benchmark score (0-100) */
  codingScore?: number;
  /** Reasoning benchmark score (0-100) */
  reasoningScore?: number;
  /** Math benchmark score (0-100) */
  mathScore?: number;
  /** MMLU-Pro score */
  mmluPro?: number;
  /** Median output tokens/sec */
  speedTps?: number;
  /** Time to first token in ms */
  ttftMs?: number;
  /** Blended cost per million tokens */
  blendedCostPerM?: number;
  /** Raw provider name from AA */
  aaProvider?: string;
  /** Raw model name from AA */
  aaModelName: string;
}

/** R2-cached benchmark catalog. */
export interface AABenchmarkCatalog {
  version: number;
  fetchedAt: number;
  /** Keyed by normalized model identifier (lowercase provider/model-slug) */
  models: Record<string, AABenchmarkData>;
  totalFetched: number;
}

export const AA_CATALOG_VERSION = 1;
export const AA_CATALOG_R2_KEY = 'sync/aa-benchmarks.json';
/** Cache TTL: 24 hours */
export const AA_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const AA_API_URL = 'https://artificialanalysis.ai/api/v2/data/llms/models';

// === API Fetching ===

/**
 * Fetch model benchmark data from Artificial Analysis API.
 */
export async function fetchAABenchmarks(apiKey: string): Promise<AAModelEntry[]> {
  const response = await fetch(AA_API_URL, {
    headers: { 'x-api-key': apiKey },
  });

  if (!response.ok) {
    throw new Error(`Artificial Analysis API returned HTTP ${response.status}: ${response.statusText}`);
  }

  const data = await response.json() as AAModelEntry[] | { data: AAModelEntry[] };
  // API may return array directly or wrapped in { data: [...] }
  return Array.isArray(data) ? data : (data.data || []);
}

// === Normalization & Matching ===

/**
 * Normalize a model name for matching across AA and OpenRouter catalogs.
 * Strips provider prefixes, version suffixes, and normalizes separators.
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
export function buildAALookup(entries: AAModelEntry[]): Map<string, AABenchmarkData> {
  const lookup = new Map<string, AABenchmarkData>();

  for (const entry of entries) {
    if (entry.intelligence_index == null && entry.coding_score == null) {
      continue; // Skip entries with no useful data
    }

    const data: AABenchmarkData = {
      intelligenceIndex: entry.intelligence_index ?? 0,
      codingScore: entry.coding_score ?? undefined,
      reasoningScore: entry.reasoning_score ?? undefined,
      mathScore: entry.math_score ?? undefined,
      mmluPro: entry.mmlu_pro ?? undefined,
      speedTps: entry.output_tokens_per_second ?? undefined,
      ttftMs: entry.time_to_first_token_ms ?? undefined,
      blendedCostPerM: entry.blended_cost_per_million ?? undefined,
      aaProvider: entry.provider_name ?? undefined,
      aaModelName: entry.model_name,
    };

    // Key 1: Raw model name normalized
    const nameKey = normalizeModelName(entry.model_name);
    if (nameKey) lookup.set(nameKey, data);

    // Key 2: provider/model-name
    if (entry.provider_name) {
      const providerKey = normalizeModelName(`${entry.provider_name}/${entry.model_name}`);
      if (providerKey) lookup.set(providerKey, data);
    }

    // Key 3: model_id if available
    if (entry.model_id) {
      lookup.set(entry.model_id.toLowerCase(), data);
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
  // Strategy 1: Exact model ID match
  const idLower = modelId.toLowerCase();
  if (aaLookup.has(idLower)) return aaLookup.get(idLower);

  // Strategy 2: Normalized display name
  const normName = normalizeModelName(modelName);
  if (aaLookup.has(normName)) return aaLookup.get(normName);

  // Strategy 3: Strip provider prefix from ID and match
  const idWithoutProvider = idLower.includes('/')
    ? idLower.split('/').slice(1).join('/')
    : idLower;
  const normId = normalizeModelName(idWithoutProvider);
  if (aaLookup.has(normId)) return aaLookup.get(normId);

  // Strategy 4: Strip version suffixes and :free/:nitro variants
  const baseId = normId
    .replace(/:free$/, '')
    .replace(/:nitro$/, '')
    .replace(/-preview$/, '')
    .replace(/-\d{4}$/, ''); // Strip date suffixes like -0528
  if (baseId !== normId && aaLookup.has(baseId)) return aaLookup.get(baseId);

  // Strategy 5: Fuzzy prefix match — find AA entries that start with our base ID
  for (const [key, data] of aaLookup) {
    if (key.startsWith(baseId) && key.length - baseId.length <= 8) {
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
