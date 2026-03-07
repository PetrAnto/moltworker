/**
 * Model Enrichment Pipeline
 *
 * Cross-references curated model catalog with:
 * 1. Artificial Analysis benchmark data (intelligence scores, coding, reasoning)
 * 2. OpenRouter API metadata (capabilities, pricing)
 *
 * Produces enriched models with verified capabilities and quality scores.
 * Run as part of /syncall, /synccheck, and on startup (from R2 cache).
 */

import type { ModelInfo, ModelBenchmarks } from '../models';
import { MODELS, getAllModels } from '../models';
import type { AABenchmarkCatalog, AABenchmarkData } from './artificial-analysis';
import {
  fetchAndCacheAABenchmarks,
  buildAALookup,
  matchModelToAA,
} from './artificial-analysis';
import type { OpenRouterApiModel } from './types';
import { detectCapabilities } from './capabilities';
import { fetchOpenRouterModels } from './sync';

// === Enrichment Result Types ===

export interface EnrichmentResult {
  success: boolean;
  totalModels: number;
  enrichedCount: number;
  missingBenchmarks: string[];
  capabilityMismatches: CapabilityMismatch[];
  durationMs: number;
  error?: string;
}

export interface CapabilityMismatch {
  alias: string;
  field: string;
  curated: unknown;
  detected: unknown;
  confidence: string;
}

export interface EnrichedModel extends ModelInfo {
  /** Whether AA benchmark data was found for this model */
  hasAAData?: boolean;
}

// === R2 Cache ===

export const ENRICHMENT_R2_KEY = 'sync/enrichment-result.json';

interface EnrichmentCache {
  version: number;
  enrichedAt: number;
  /** Enrichment patches keyed by model alias */
  patches: Record<string, Partial<ModelInfo>>;
}

const ENRICHMENT_CACHE_VERSION = 1;

// === Enrichment Logic ===

/**
 * Compute the orchestra readiness score for a model.
 * Uses AA benchmark data when available, falls back to heuristic.
 *
 * A model is orchestra-ready if it:
 * - Supports tool calling
 * - Has strong coding/reasoning scores OR is from a known agentic family
 * - Has sufficient context window (>= 64K)
 */
export function computeOrchestraReady(
  model: ModelInfo,
  aaBenchmark?: AABenchmarkData,
): boolean {
  // Must support tools
  if (!model.supportsTools) return false;

  // Image gen models are never orchestra-ready
  if (model.isImageGen) return false;

  // Codex models support tools in metadata but don't use them in practice
  // (they output code/plans as text instead of making function calls)
  if (/codex/i.test(model.id)) return false;

  // Context must be >= 64K
  if ((model.maxContext || 0) < 64000) return false;

  // If we have AA data, use coding score and intelligence index as signals
  if (aaBenchmark) {
    const codingScore = aaBenchmark.codingScore ?? 0;
    // Strong coding score = orchestra-ready
    if (codingScore >= 40) return true;
    // High intelligence index is also a good signal
    if (aaBenchmark.intelligenceIndex >= 45) return true;
    // Good LiveCodeBench score
    if ((aaBenchmark.livecodebench ?? 0) >= 40) return true;
  }

  // Heuristic fallback: check specialty/score strings
  const lower = (model.name + ' ' + model.specialty + ' ' + model.score).toLowerCase();
  if (/agentic|multi-?file|swe-?bench/i.test(lower)) return true;
  if (/dense/i.test(lower) && (model.maxContext || 0) >= 128000) return true;

  // Known strong orchestra models by family
  const idLower = model.id.toLowerCase();
  if (/claude-(sonnet|opus)|gpt-4o|gemini-3-(pro|flash)|grok-4|deepseek-(v3|chat)|devstral|qwen3-coder|minimax-m2/.test(idLower)) {
    return true;
  }

  return false;
}

/**
 * Run the full enrichment pipeline.
 *
 * 1. Fetch AA benchmark data (from cache or API)
 * 2. Optionally fetch OpenRouter live data for capability verification
 * 3. Match each curated model to AA data
 * 4. Compute orchestra readiness
 * 5. Detect capability mismatches
 * 6. Cache results in R2
 */
export async function runEnrichment(
  bucket: R2Bucket,
  aaApiKey?: string,
  openrouterApiKey?: string,
  options?: { skipOpenRouter?: boolean },
): Promise<EnrichmentResult> {
  const startTime = Date.now();

  try {
    // 1. Load or fetch AA benchmarks
    let aaCatalog: AABenchmarkCatalog | null = null;
    if (aaApiKey) {
      aaCatalog = await fetchAndCacheAABenchmarks(bucket, aaApiKey);
    }

    const aaLookup = aaCatalog
      ? new Map(Object.entries(aaCatalog.models))
      : new Map<string, AABenchmarkData>();

    // 2. Optionally fetch OpenRouter for capability verification
    let orModelsById: Map<string, OpenRouterApiModel> | null = null;
    if (openrouterApiKey && !options?.skipOpenRouter) {
      try {
        const orModels = await fetchOpenRouterModels(openrouterApiKey);
        orModelsById = new Map(orModels.map(m => [m.id, m]));
      } catch (err) {
        console.warn(`[Enrich] OpenRouter fetch failed, skipping capability verification: ${err}`);
      }
    }

    // 3. Enrich all curated models
    const patches: Record<string, Partial<ModelInfo>> = {};
    const missingBenchmarks: string[] = [];
    const capabilityMismatches: CapabilityMismatch[] = [];
    let enrichedCount = 0;

    const allModels = { ...MODELS }; // Enrich curated only
    for (const [alias, model] of Object.entries(allModels)) {
      // Skip special models
      if (model.id === 'openrouter/auto') continue;
      if (model.isImageGen) continue;

      const patch: Partial<ModelInfo> = {};

      // Match to AA data
      const aaData = matchModelToAA(model.id, model.name, aaLookup);
      if (aaData) {
        if (aaData.intelligenceIndex > 0) {
          patch.intelligenceIndex = aaData.intelligenceIndex;
        }

        const benchmarks: ModelBenchmarks = {};
        if (aaData.codingScore != null) benchmarks.coding = aaData.codingScore;
        if (aaData.mathScore != null) benchmarks.math = aaData.mathScore;
        if (aaData.mmluPro != null) benchmarks.mmluPro = aaData.mmluPro;
        if (aaData.gpqa != null) benchmarks.gpqa = aaData.gpqa;
        if (aaData.livecodebench != null) benchmarks.livecodebench = aaData.livecodebench;
        if (aaData.speedTps != null) benchmarks.speedTps = aaData.speedTps;

        if (Object.keys(benchmarks).length > 0) {
          patch.benchmarks = benchmarks;
        }

        enrichedCount++;
      } else {
        missingBenchmarks.push(alias);
      }

      // Compute orchestra readiness
      const orchestraReady = computeOrchestraReady(model, aaData ?? undefined);
      if (orchestraReady !== (model.orchestraReady ?? false)) {
        patch.orchestraReady = orchestraReady;
      }

      // Verify capabilities against OpenRouter if available
      if (orModelsById && !model.provider) {
        const orModel = orModelsById.get(model.id);
        if (orModel) {
          const detected = detectCapabilities(orModel);

          // Check tool support mismatch
          if (detected.supportsTools.confidence === 'high') {
            if (!!model.supportsTools !== detected.supportsTools.value) {
              capabilityMismatches.push({
                alias,
                field: 'supportsTools',
                curated: model.supportsTools ?? false,
                detected: detected.supportsTools.value,
                confidence: detected.supportsTools.confidence,
              });
            }
          }

          // Check vision mismatch
          if (detected.supportsVision.confidence === 'high') {
            if (!!model.supportsVision !== detected.supportsVision.value) {
              capabilityMismatches.push({
                alias,
                field: 'supportsVision',
                curated: model.supportsVision ?? false,
                detected: detected.supportsVision.value,
                confidence: detected.supportsVision.confidence,
              });
            }
          }

          // Check context window
          if (orModel.context_length && model.maxContext) {
            if (Math.abs(orModel.context_length - model.maxContext) > model.maxContext * 0.1) {
              capabilityMismatches.push({
                alias,
                field: 'maxContext',
                curated: model.maxContext,
                detected: orModel.context_length,
                confidence: 'high',
              });
            }
          }

          // Check structured output
          if (detected.structuredOutput.confidence === 'high') {
            if (!!model.structuredOutput !== detected.structuredOutput.value) {
              capabilityMismatches.push({
                alias,
                field: 'structuredOutput',
                curated: model.structuredOutput ?? false,
                detected: detected.structuredOutput.value,
                confidence: detected.structuredOutput.confidence,
              });
            }
          }
        }
      }

      // Only store patch if it has changes
      if (Object.keys(patch).length > 0) {
        patches[alias] = patch;
      }
    }

    // 4. Cache enrichment results
    const cache: EnrichmentCache = {
      version: ENRICHMENT_CACHE_VERSION,
      enrichedAt: Date.now(),
      patches,
    };

    await bucket.put(ENRICHMENT_R2_KEY, JSON.stringify(cache), {
      httpMetadata: { contentType: 'application/json' },
    });

    console.log(`[Enrich] Complete: ${enrichedCount} enriched, ${missingBenchmarks.length} missing AA data, ${capabilityMismatches.length} mismatches`);

    return {
      success: true,
      totalModels: Object.keys(allModels).length,
      enrichedCount,
      missingBenchmarks,
      capabilityMismatches,
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[Enrich] Failed: ${msg}`);
    return {
      success: false,
      totalModels: 0,
      enrichedCount: 0,
      missingBenchmarks: [],
      capabilityMismatches: [],
      durationMs: Date.now() - startTime,
      error: msg,
    };
  }
}

/**
 * Load cached enrichment patches from R2 and apply to runtime models.
 * Called on startup to restore benchmark data without re-fetching.
 */
export async function loadAndApplyEnrichment(bucket: R2Bucket): Promise<number> {
  try {
    const obj = await bucket.get(ENRICHMENT_R2_KEY);
    if (!obj) return 0;

    const cache = await obj.json() as EnrichmentCache;
    if (cache.version !== ENRICHMENT_CACHE_VERSION) return 0;

    let applied = 0;
    for (const [alias, patch] of Object.entries(cache.patches)) {
      const model = MODELS[alias];
      if (model) {
        Object.assign(model, patch);
        applied++;
      }
    }

    console.log(`[Enrich] Applied ${applied} cached enrichment patches (cached ${new Date(cache.enrichedAt).toISOString()})`);
    return applied;
  } catch {
    console.error('[Enrich] Failed to load enrichment cache');
    return 0;
  }
}

/**
 * Format enrichment result for Telegram display.
 */
export function formatEnrichmentMessage(result: EnrichmentResult): string {
  if (!result.success) {
    return `❌ Enrichment failed: ${result.error}`;
  }

  const lines: string[] = ['🧠 Model Enrichment Report\n'];

  lines.push(`✅ ${result.enrichedCount}/${result.totalModels} models enriched with AA benchmark data`);

  if (result.capabilityMismatches.length > 0) {
    lines.push('\n⚠️ Capability mismatches detected:');
    for (const m of result.capabilityMismatches) {
      lines.push(`  /${m.alias} — ${m.field}: curated=${String(m.curated)}, live=${String(m.detected)} (${m.confidence})`);
    }
  }

  if (result.missingBenchmarks.length > 0) {
    const shown = result.missingBenchmarks.slice(0, 10);
    lines.push(`\n📊 No AA data for: ${shown.map(a => '/' + a).join(', ')}${result.missingBenchmarks.length > 10 ? ` +${result.missingBenchmarks.length - 10} more` : ''}`);
  }

  lines.push(`\n⚡ ${result.durationMs}ms`);

  return lines.join('\n');
}
