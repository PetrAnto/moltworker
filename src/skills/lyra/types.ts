/**
 * Lyra (Crex) — Content Creator Types
 *
 * Interfaces and type guards for Lyra skill artifacts.
 */

/** The structured artifact Lyra produces from an LLM call. */
export interface LyraArtifact {
  /** The generated content. */
  content: string;
  /** Self-assessed quality score (1-5). */
  quality: number;
  /** Brief rationale for the quality score. */
  qualityNote?: string;
  /** Target platform/format if specified (e.g. "twitter", "linkedin"). */
  platform?: string;
  /** Tone used (e.g. "casual", "formal", "technical"). */
  tone?: string;
}

/** Type guard for LyraArtifact parsed from JSON. */
export function isLyraArtifact(v: unknown): v is LyraArtifact {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.content === 'string' &&
    obj.content.length > 0 &&
    typeof obj.quality === 'number' &&
    obj.quality >= 1 &&
    obj.quality <= 5
  );
}

/** Headline variant produced by /headline. */
export interface HeadlineVariant {
  /** The headline text. */
  headline: string;
  /** Brief commentary on why this variant works. */
  commentary: string;
}

/** Structured response from /headline. */
export interface HeadlineResult {
  variants: HeadlineVariant[];
}

/** Type guard for HeadlineResult parsed from JSON. */
export function isHeadlineResult(v: unknown): v is HeadlineResult {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  if (!Array.isArray(obj.variants)) return false;
  return obj.variants.every((item: unknown) => {
    if (typeof item !== 'object' || item === null) return false;
    const h = item as Record<string, unknown>;
    return typeof h.headline === 'string' && typeof h.commentary === 'string';
  });
}

/** Stored draft in R2 for /rewrite access. */
export interface StoredDraft {
  content: string;
  quality: number;
  platform?: string;
  tone?: string;
  createdAt: string;
  command: string;
}
