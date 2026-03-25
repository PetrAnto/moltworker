/**
 * Tests for Spark type guards
 */

import { describe, it, expect } from 'vitest';
import { isSparkItem, isSparkReaction, isSparkGauntlet, isBrainstormResult } from './types';

describe('isSparkItem', () => {
  it('returns true for valid item', () => {
    expect(isSparkItem({ id: 'abc', text: 'My idea', createdAt: '2026-03-25' })).toBe(true);
  });

  it('returns true with optional fields', () => {
    expect(isSparkItem({ id: 'abc', text: 'My idea', url: 'https://x.com', summary: 'A link', createdAt: '2026-03-25' })).toBe(true);
  });

  it('returns false for missing fields', () => {
    expect(isSparkItem({ id: '', text: 'x', createdAt: '2026' })).toBe(false);
    expect(isSparkItem({ id: 'abc', text: '', createdAt: '2026' })).toBe(false);
    expect(isSparkItem({ id: 'abc', text: 'x' })).toBe(false);
  });

  it('returns false for non-objects', () => {
    expect(isSparkItem(null)).toBe(false);
    expect(isSparkItem([])).toBe(false);
  });
});

describe('isSparkReaction', () => {
  it('returns true for valid reaction', () => {
    expect(isSparkReaction({ reaction: 'Cool!', angle: 'B2B', nextStep: 'Prototype' })).toBe(true);
  });

  it('returns false for missing fields', () => {
    expect(isSparkReaction({ reaction: 'Cool!' })).toBe(false);
  });
});

describe('isSparkGauntlet', () => {
  it('returns true for valid gauntlet', () => {
    expect(isSparkGauntlet({
      idea: 'Test',
      stages: [{ name: 'Feasibility', score: 4, assessment: 'Good' }],
      verdict: 'Go',
      overallScore: 4.0,
    })).toBe(true);
  });

  it('returns false for invalid stages', () => {
    expect(isSparkGauntlet({
      idea: 'Test',
      stages: [{ name: 'Feasibility', score: 'high' }], // score should be number
      verdict: 'Go',
      overallScore: 4.0,
    })).toBe(false);
  });

  it('returns false for missing verdict', () => {
    expect(isSparkGauntlet({ idea: 'Test', stages: [], overallScore: 0 })).toBe(false);
  });
});

describe('isBrainstormResult', () => {
  it('returns true for valid result', () => {
    expect(isBrainstormResult({
      clusters: [{ theme: 'AI', insight: 'Pattern', challenge: 'Why?', itemIds: ['a'] }],
      synthesis: 'Overall insight',
    })).toBe(true);
  });

  it('returns true for empty clusters', () => {
    expect(isBrainstormResult({ clusters: [], synthesis: 'Nothing found' })).toBe(true);
  });

  it('returns false for missing synthesis', () => {
    expect(isBrainstormResult({ clusters: [] })).toBe(false);
  });
});
