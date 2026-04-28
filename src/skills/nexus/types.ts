/**
 * Nexus (Omni) — Research Types
 */

/** Confidence tier for evidence items. */
export type ConfidenceTier = 'high' | 'medium' | 'low';

/** A single piece of evidence gathered from a source. */
export interface EvidenceItem {
  /** Source name (e.g. "Wikipedia", "Brave Search"). */
  source: string;
  /** URL of the source (if applicable). */
  url?: string;
  /** Extracted text/data from the source. */
  data: string;
  /** Confidence in this evidence. */
  confidence: ConfidenceTier;
}

/**
 * Per-source attempt record. Captured by fetchSources for every source the
 * classifier asked us to try, regardless of outcome. Surfaced in the
 * rendered dossier when any source fails so the user (and we) can see
 * exactly which fetchers ran and why each non-evidence source dropped —
 * without needing wrangler tail. Field is optional for backwards
 * compatibility with cached pre-2026-04-27 dossiers in KV.
 */
export interface SourceAttempt {
  /** Registry key (e.g. "stackExchange", "github"). */
  source: string;
  status: 'ok' | 'failed';
  /** Failure reason; empty when status === 'ok'. */
  reason?: string;
  /** Wall-clock duration of the fetch in milliseconds. */
  durationMs: number;
}

/** A completed research dossier. */
export interface NexusDossier {
  /** The research query/topic. */
  query: string;
  /** Research mode used. */
  mode: 'quick' | 'full' | 'decision';
  /** Synthesized answer/analysis. */
  synthesis: string;
  /** Evidence items backing the synthesis. */
  evidence: EvidenceItem[];
  /**
   * Per-source attempt outcomes (see SourceAttempt). Optional so cached
   * dossiers from before 2026-04-27 still parse cleanly via isNexusDossier.
   */
  attempts?: SourceAttempt[];
  /** For decision mode: structured pros/cons/risks. */
  decision?: {
    pros: string[];
    cons: string[];
    risks: string[];
    recommendation: string;
  };
  /** When the dossier was generated. */
  createdAt: string;
}

/** Type guard for NexusDossier. */
export function isNexusDossier(v: unknown): v is NexusDossier {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.query === 'string' &&
    typeof obj.synthesis === 'string' &&
    typeof obj.mode === 'string' &&
    Array.isArray(obj.evidence)
  );
}

/** LLM-generated synthesis response. */
export interface SynthesisResponse {
  synthesis: string;
  decision?: {
    pros: string[];
    cons: string[];
    risks: string[];
    recommendation: string;
  };
}

/** Type guard for SynthesisResponse. */
export function isSynthesisResponse(v: unknown): v is SynthesisResponse {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  return typeof obj.synthesis === 'string';
}

/** Query classification result from the LLM. */
export type QueryCategory = 'entity' | 'topic' | 'market' | 'decision' | 'technical';

export interface QueryClassification {
  category: QueryCategory;
  /** Suggested source pack names to use. */
  sources: string[];
  /**
   * 2-4 distinctive keyword tokens distilled from the query, suitable for
   * keyword-strict APIs (GitHub, Stack Exchange, Wikidata) that AND every
   * token. Optional — when missing, source-packs falls back to the local
   * stop-word-based extractor. The LLM classifier knows which words are
   * domain-distinctive far better than a heuristic, so we prefer this.
   */
  keywordQuery?: string;
}

/** Type guard for QueryClassification. */
export function isQueryClassification(v: unknown): v is QueryClassification {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  return typeof obj.category === 'string' && Array.isArray(obj.sources);
}
