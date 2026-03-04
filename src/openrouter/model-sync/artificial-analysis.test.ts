/**
 * Tests for Artificial Analysis API client and model matching.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeModelName,
  buildAALookup,
  matchModelToAA,
  type AAApiModel,
} from './artificial-analysis';

/** Helper to create a minimal AA model entry. */
function makeAAModel(overrides: Partial<AAApiModel> & { name: string }): AAApiModel {
  return {
    id: 'test-uuid',
    slug: normalizeModelName(overrides.name).replace(/\./g, '-'),
    model_creator: { id: 'c-uuid', name: 'Unknown', slug: 'unknown' },
    ...overrides,
  };
}

describe('normalizeModelName', () => {
  it('lowercases and converts spaces to hyphens', () => {
    expect(normalizeModelName('Claude Sonnet 4.5')).toBe('claude-sonnet-4.5');
  });

  it('handles GPT-4o', () => {
    expect(normalizeModelName('GPT-4o')).toBe('gpt-4o');
  });

  it('handles DeepSeek V3.2', () => {
    expect(normalizeModelName('DeepSeek V3.2')).toBe('deepseek-v3.2');
  });

  it('strips parentheses', () => {
    expect(normalizeModelName('Phi-4 Reasoning (Plus)')).toBe('phi-4-reasoning-plus');
  });

  it('collapses multiple separators', () => {
    expect(normalizeModelName('model__with--extra   spaces')).toBe('model-with-extra-spaces');
  });
});

describe('buildAALookup', () => {
  const entries: AAApiModel[] = [
    makeAAModel({
      name: 'Claude Sonnet 4.5',
      slug: 'claude-sonnet-4-5',
      model_creator: { id: 'c1', name: 'Anthropic', slug: 'anthropic' },
      evaluations: {
        artificial_analysis_intelligence_index: 52.3,
        artificial_analysis_coding_index: 48.5,
        artificial_analysis_math_index: 55.1,
      },
    }),
    makeAAModel({
      name: 'GPT-4o',
      slug: 'gpt-4o',
      model_creator: { id: 'c2', name: 'OpenAI', slug: 'openai' },
      evaluations: {
        artificial_analysis_intelligence_index: 38.2,
        artificial_analysis_coding_index: 35.0,
      },
    }),
    makeAAModel({
      name: 'No Data Model',
      model_creator: { id: 'c3', name: 'Unknown', slug: 'unknown' },
      // No evaluations
    }),
  ];

  it('builds lookup with multiple keys per entry', () => {
    const lookup = buildAALookup(entries);
    // Should find by normalized name
    expect(lookup.has('claude-sonnet-4.5')).toBe(true);
    // Should find by slug
    expect(lookup.has('claude-sonnet-4-5')).toBe(true);
    // Should find by creator/name
    expect(lookup.has('anthropic/claude-sonnet-4.5')).toBe(true);
    // Should find by creator-slug/model-slug
    expect(lookup.has('anthropic/claude-sonnet-4-5')).toBe(true);
  });

  it('skips entries with no useful data', () => {
    const lookup = buildAALookup(entries);
    expect(lookup.has('no-data-model')).toBe(false);
  });

  it('stores correct benchmark data', () => {
    const lookup = buildAALookup(entries);
    const sonnet = lookup.get('claude-sonnet-4.5');
    expect(sonnet).toBeDefined();
    expect(sonnet!.intelligenceIndex).toBe(52.3);
    expect(sonnet!.codingScore).toBe(48.5);
    expect(sonnet!.mathScore).toBe(55.1);
    expect(sonnet!.aaModelName).toBe('Claude Sonnet 4.5');
    expect(sonnet!.aaCreator).toBe('Anthropic');
  });
});

describe('matchModelToAA', () => {
  const aaEntries: AAApiModel[] = [
    makeAAModel({
      name: 'Claude Sonnet 4.5',
      slug: 'claude-sonnet-4-5',
      model_creator: { id: 'c1', name: 'Anthropic', slug: 'anthropic' },
      evaluations: { artificial_analysis_intelligence_index: 52.3, artificial_analysis_coding_index: 48.5 },
    }),
    makeAAModel({
      name: 'GPT-4o',
      slug: 'gpt-4o',
      model_creator: { id: 'c2', name: 'OpenAI', slug: 'openai' },
      evaluations: { artificial_analysis_intelligence_index: 38.2, artificial_analysis_coding_index: 35.0 },
    }),
    makeAAModel({
      name: 'DeepSeek V3.2',
      slug: 'deepseek-v3-2',
      model_creator: { id: 'c3', name: 'DeepSeek', slug: 'deepseek' },
      evaluations: { artificial_analysis_intelligence_index: 45.0, artificial_analysis_coding_index: 42.0 },
    }),
    makeAAModel({
      name: 'Grok 4.1',
      slug: 'grok-4-1',
      model_creator: { id: 'c4', name: 'xAI', slug: 'xai' },
      evaluations: { artificial_analysis_intelligence_index: 50.0, artificial_analysis_coding_index: 46.0 },
    }),
  ];

  const aaLookup = buildAALookup(aaEntries);

  it('matches by normalized display name', () => {
    const result = matchModelToAA('openai/gpt-4o', 'GPT-4o', aaLookup);
    expect(result).toBeDefined();
    expect(result!.intelligenceIndex).toBe(38.2);
  });

  it('matches by slug (dots → hyphens)', () => {
    // Our model ID "anthropic/claude-sonnet-4.5" → stripped to "claude-sonnet-4.5"
    // AA slug is "claude-sonnet-4-5" → matched via dot-to-hyphen strategy
    const result = matchModelToAA('anthropic/claude-sonnet-4.5', 'Claude Sonnet 4.5', aaLookup);
    expect(result).toBeDefined();
    expect(result!.intelligenceIndex).toBe(52.3);
  });

  it('matches by stripped ID without provider', () => {
    const result = matchModelToAA('deepseek/deepseek-v3.2', 'DeepSeek V3.2', aaLookup);
    expect(result).toBeDefined();
    expect(result!.intelligenceIndex).toBe(45.0);
  });

  it('matches stripping :free suffix', () => {
    const result = matchModelToAA('openai/gpt-4o:free', 'GPT-4o (Free)', aaLookup);
    expect(result).toBeDefined();
  });

  it('returns undefined for unknown models', () => {
    const result = matchModelToAA('unknown/model-xyz', 'Unknown Model XYZ', aaLookup);
    expect(result).toBeUndefined();
  });

  it('matches grok with version dot-to-hyphen', () => {
    const result = matchModelToAA('x-ai/grok-4.1-fast', 'Grok 4.1 Fast', aaLookup);
    expect(result).toBeDefined();
    expect(result!.intelligenceIndex).toBe(50.0);
  });
});
