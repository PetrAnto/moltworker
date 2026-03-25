/**
 * Tests for Lyra type guards
 */

import { describe, it, expect } from 'vitest';
import { isLyraArtifact, isHeadlineResult } from './types';

describe('isLyraArtifact', () => {
  it('returns true for valid artifact', () => {
    expect(isLyraArtifact({
      content: 'Hello world',
      quality: 4,
      qualityNote: 'Good',
      platform: 'twitter',
      tone: 'casual',
    })).toBe(true);
  });

  it('returns true for minimal artifact', () => {
    expect(isLyraArtifact({ content: 'Hello', quality: 1 })).toBe(true);
  });

  it('returns false for empty content', () => {
    expect(isLyraArtifact({ content: '', quality: 3 })).toBe(false);
  });

  it('returns false for quality out of range', () => {
    expect(isLyraArtifact({ content: 'Hello', quality: 0 })).toBe(false);
    expect(isLyraArtifact({ content: 'Hello', quality: 6 })).toBe(false);
  });

  it('returns false for missing content', () => {
    expect(isLyraArtifact({ quality: 3 })).toBe(false);
  });

  it('returns false for non-objects', () => {
    expect(isLyraArtifact(null)).toBe(false);
    expect(isLyraArtifact('string')).toBe(false);
    expect(isLyraArtifact(42)).toBe(false);
    expect(isLyraArtifact([])).toBe(false);
  });
});

describe('isHeadlineResult', () => {
  it('returns true for valid result', () => {
    expect(isHeadlineResult({
      variants: [
        { headline: 'Test', commentary: 'Good' },
        { headline: 'Test 2', commentary: 'Also good' },
      ],
    })).toBe(true);
  });

  it('returns true for empty variants array', () => {
    expect(isHeadlineResult({ variants: [] })).toBe(true);
  });

  it('returns false for missing variants', () => {
    expect(isHeadlineResult({})).toBe(false);
    expect(isHeadlineResult({ headlines: [] })).toBe(false);
  });

  it('returns false for invalid variant items', () => {
    expect(isHeadlineResult({
      variants: [{ headline: 'Test' }], // missing commentary
    })).toBe(false);
  });

  it('returns false for non-objects', () => {
    expect(isHeadlineResult(null)).toBe(false);
    expect(isHeadlineResult([])).toBe(false);
  });
});
