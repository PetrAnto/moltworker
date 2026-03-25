/**
 * Tests for Nexus type guards
 */

import { describe, it, expect } from 'vitest';
import { isNexusDossier, isSynthesisResponse, isQueryClassification } from './types';

describe('isNexusDossier', () => {
  it('returns true for valid dossier', () => {
    expect(isNexusDossier({
      query: 'AI trends',
      mode: 'quick',
      synthesis: 'Analysis here',
      evidence: [{ source: 'Web', data: 'stuff', confidence: 'high' }],
      createdAt: '2026-03-25',
    })).toBe(true);
  });

  it('returns true with empty evidence', () => {
    expect(isNexusDossier({ query: 'test', mode: 'quick', synthesis: 'x', evidence: [] })).toBe(true);
  });

  it('returns false for missing fields', () => {
    expect(isNexusDossier({ query: 'test', synthesis: 'x' })).toBe(false);
    expect(isNexusDossier({ query: 'test', mode: 'quick', evidence: [] })).toBe(false);
  });

  it('returns false for non-objects', () => {
    expect(isNexusDossier(null)).toBe(false);
    expect(isNexusDossier([])).toBe(false);
  });
});

describe('isSynthesisResponse', () => {
  it('returns true for valid response', () => {
    expect(isSynthesisResponse({ synthesis: 'Analysis' })).toBe(true);
  });

  it('returns true with decision', () => {
    expect(isSynthesisResponse({
      synthesis: 'Analysis',
      decision: { pros: ['a'], cons: ['b'], risks: ['c'], recommendation: 'd' },
    })).toBe(true);
  });

  it('returns false for missing synthesis', () => {
    expect(isSynthesisResponse({ text: 'wrong field' })).toBe(false);
  });
});

describe('isQueryClassification', () => {
  it('returns true for valid classification', () => {
    expect(isQueryClassification({ category: 'topic', sources: ['webSearch', 'wikipedia'] })).toBe(true);
  });

  it('returns false for missing sources', () => {
    expect(isQueryClassification({ category: 'topic' })).toBe(false);
  });

  it('returns false for non-array sources', () => {
    expect(isQueryClassification({ category: 'topic', sources: 'webSearch' })).toBe(false);
  });
});
