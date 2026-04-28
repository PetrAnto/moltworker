/**
 * Tests for Nexus evidence model
 */

import { describe, it, expect } from 'vitest';
import { computeConfidence, confidenceLabel, formatEvidenceForLLM, formatEvidenceSummary } from './evidence';
import type { EvidenceItem } from './types';

describe('computeConfidence', () => {
  it('returns 0 for empty evidence', () => {
    expect(computeConfidence([])).toBe(0);
  });

  it('returns high score for multiple high-confidence sources', () => {
    const evidence: EvidenceItem[] = [
      { source: 'Wikipedia', data: 'x', confidence: 'high' },
      { source: 'Web', data: 'y', confidence: 'high' },
      { source: 'News', data: 'z', confidence: 'high' },
    ];
    const score = computeConfidence(evidence);
    expect(score).toBeGreaterThan(0.8);
  });

  it('returns lower score for low-confidence sources', () => {
    const evidence: EvidenceItem[] = [
      { source: 'Reddit', data: 'x', confidence: 'low' },
    ];
    const score = computeConfidence(evidence);
    expect(score).toBeLessThan(0.6);
  });

  it('caps at 1.0', () => {
    const evidence: EvidenceItem[] = Array.from({ length: 10 }, (_, i) => ({
      source: `Source${i}`, data: 'x', confidence: 'high' as const,
    }));
    expect(computeConfidence(evidence)).toBeLessThanOrEqual(1.0);
  });
});

describe('confidenceLabel', () => {
  it('returns appropriate labels', () => {
    expect(confidenceLabel(0.9)).toBe('High confidence');
    expect(confidenceLabel(0.6)).toBe('Medium confidence');
    expect(confidenceLabel(0.3)).toBe('Low confidence');
    expect(confidenceLabel(0.1)).toBe('Very low confidence');
  });
});

describe('formatEvidenceForLLM', () => {
  it('formats evidence with name-based citation tokens', () => {
    const evidence: EvidenceItem[] = [
      { source: 'Wikipedia', url: 'https://wiki.example', data: 'Facts here', confidence: 'high' },
    ];
    const text = formatEvidenceForLLM(evidence);
    // Citation token is the bracketed source name — what the synthesis
    // LLM is told to mirror in its output. NOT [Source 1].
    expect(text).toContain('[Wikipedia]');
    expect(text).toContain('https://wiki.example');
    expect(text).toContain('Facts here');
    expect(text).not.toMatch(/\[Source\s+\d+/);
  });

  it('separates multiple sources and tags each by name', () => {
    const evidence: EvidenceItem[] = [
      { source: 'Brave Search', data: 'a', confidence: 'medium' },
      { source: 'OpenAlex', data: 'b', confidence: 'high' },
    ];
    const text = formatEvidenceForLLM(evidence);
    expect(text).toContain('[Brave Search]');
    expect(text).toContain('[OpenAlex]');
    expect(text).toContain('---');
    expect(text).not.toMatch(/\[Source\s+\d+/);
  });

  it('never exceeds MAX_EVIDENCE_CHARS total', () => {
    // 5 sources each with 5000 chars of data → 25 000 chars uncapped
    const evidence: EvidenceItem[] = Array.from({ length: 5 }, (_, i) => ({
      source: `Source${i}`,
      data: 'x'.repeat(5000),
      confidence: 'medium' as const,
    }));
    const text = formatEvidenceForLLM(evidence);
    // Allow small overage for headers and separators (≤ 500 chars)
    expect(text.length).toBeLessThan(12_500);
  });

  it('preserves source headers even when body is truncated', () => {
    const evidence: EvidenceItem[] = [
      { source: 'GitHub', url: 'https://github.com', data: 'x'.repeat(5000), confidence: 'high' },
      { source: 'Brave Search', data: 'y'.repeat(5000), confidence: 'medium' },
    ];
    const text = formatEvidenceForLLM(evidence);
    // Headers must always be present regardless of truncation
    expect(text).toContain('[GitHub]');
    expect(text).toContain('[Brave Search]');
    expect(text).toContain('https://github.com');
  });

  it('returns empty string for empty evidence', () => {
    expect(formatEvidenceForLLM([])).toBe('');
  });
});

describe('formatEvidenceSummary', () => {
  it('returns empty message for no evidence', () => {
    expect(formatEvidenceSummary([])).toContain('No sources');
  });

  it('formats bullet list', () => {
    const evidence: EvidenceItem[] = [
      { source: 'Web', data: 'x', confidence: 'medium' },
    ];
    const summary = formatEvidenceSummary(evidence);
    expect(summary).toContain('Web');
    expect(summary).toContain('medium');
  });
});
