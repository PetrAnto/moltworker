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
}

/** Type guard for QueryClassification. */
export function isQueryClassification(v: unknown): v is QueryClassification {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  return typeof obj.category === 'string' && Array.isArray(obj.sources);
}
