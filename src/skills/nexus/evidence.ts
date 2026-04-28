/**
 * Nexus — Evidence Aggregation + Confidence Scoring
 */

import type { EvidenceItem, ConfidenceTier } from './types';
import { MAX_EVIDENCE_CHARS } from './config';

/** Weight per confidence tier for scoring. */
const CONFIDENCE_WEIGHTS: Record<ConfidenceTier, number> = {
  high: 1.0,
  medium: 0.6,
  low: 0.3,
};

/**
 * Compute an overall confidence score from evidence items.
 * Returns 0-1 based on count, diversity, and confidence tiers.
 */
export function computeConfidence(evidence: EvidenceItem[]): number {
  if (evidence.length === 0) return 0;

  // Weighted average of individual confidences
  const totalWeight = evidence.reduce((sum, e) => sum + CONFIDENCE_WEIGHTS[e.confidence], 0);
  const avgWeight = totalWeight / evidence.length;

  // Bonus for source diversity
  const uniqueSources = new Set(evidence.map(e => e.source)).size;
  const diversityBonus = Math.min(uniqueSources / 3, 1) * 0.2;

  // Bonus for count (diminishing returns)
  const countBonus = Math.min(evidence.length / 5, 1) * 0.1;

  return Math.min(avgWeight + diversityBonus + countBonus, 1);
}

/**
 * Label a confidence score as a human-readable tier.
 */
export function confidenceLabel(score: number): string {
  if (score >= 0.8) return 'High confidence';
  if (score >= 0.5) return 'Medium confidence';
  if (score >= 0.2) return 'Low confidence';
  return 'Very low confidence';
}

/**
 * Format evidence items as a text block for LLM consumption.
 *
 * Citation tokens are the source NAME wrapped in brackets — e.g.
 * `[Brave Search]`, `[OpenAlex]`. We deliberately avoid `[Source N]` index
 * tokens because the model otherwise extrapolates and invents `[Source 2]`
 * when only one source was actually fetched (observed in production on
 * single-source dossiers). Names are also what we render in the user-facing
 * Sources block, so quotes line up visually.
 */
/**
 * Format a single evidence item header (source name + URL line).
 * The header is always preserved in full so citations are never truncated.
 */
function evidenceHeader(e: EvidenceItem): string {
  const urlLine = e.url ? ` ${e.url}` : '';
  return `[${e.source}] (confidence: ${e.confidence})${urlLine}`;
}

/**
 * Format evidence for LLM synthesis with a per-source character budget.
 *
 * Each source gets an equal share of MAX_EVIDENCE_CHARS. Source headers
 * are always preserved in full; only the body data is truncated. This
 * avoids the raw 12 000-char slice which could cut a source mid-entry or
 * lose source names entirely.
 */
export function formatEvidenceForLLM(evidence: EvidenceItem[]): string {
  if (evidence.length === 0) return '';
  const perSource = Math.floor(MAX_EVIDENCE_CHARS / evidence.length);
  return evidence
    .map(e => {
      const header = evidenceHeader(e);
      const bodyBudget = Math.max(perSource - header.length - 2, 100);
      const body = e.data.length > bodyBudget
        ? e.data.slice(0, bodyBudget) + '…'
        : e.data;
      return `${header}\n${body}`;
    })
    .join('\n\n---\n\n');
}

/**
 * Format evidence for Telegram display (shorter).
 */
export function formatEvidenceSummary(evidence: EvidenceItem[]): string {
  if (evidence.length === 0) return 'No sources found.';

  return evidence
    .map(e => {
      const urlTag = e.url ? ` — ${e.url}` : '';
      return `\u2022 ${e.source} (${e.confidence})${urlTag}`;
    })
    .join('\n');
}
