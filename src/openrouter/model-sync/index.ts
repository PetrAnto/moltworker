/**
 * Model Sync Module — automated full catalog sync from OpenRouter
 * + Artificial Analysis benchmark enrichment.
 */

export { detectCapabilities, formatCostString } from './capabilities';
export { generateAlias, collectExistingAliases } from './alias';
export { runFullSync, loadCatalog, loadAutoSyncedModels, fetchOpenRouterModels } from './sync';
export { runSyncCheck, formatSyncCheckMessage } from './synccheck';
export type { SyncCheckResult, CuratedCheckResult, NewFamilyModel } from './synccheck';
export {
  fetchAABenchmarks,
  fetchAndCacheAABenchmarks,
  loadAABenchmarks,
  buildAALookup,
  matchModelToAA,
  normalizeModelName,
} from './artificial-analysis';
export type { AAModelEntry, AABenchmarkData, AABenchmarkCatalog } from './artificial-analysis';
export {
  runEnrichment,
  loadAndApplyEnrichment,
  formatEnrichmentMessage,
  computeOrchestraReady,
} from './enrich';
export type { EnrichmentResult, CapabilityMismatch, EnrichedModel } from './enrich';
export type {
  OpenRouterApiModel,
  OpenRouterApiResponse,
  SyncCatalog,
  SyncResult,
  DeprecationState,
  DeprecationEntry,
  DetectedCapabilities,
  ConfidenceLevel,
} from './types';
export {
  SYNC_CATALOG_R2_KEY,
  SYNC_CATALOG_VERSION,
} from './types';
