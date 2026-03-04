/**
 * Tests for Artificial Analysis API client and model matching.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeModelName,
  buildAALookup,
  matchModelToAA,
  type AAModelEntry,
  type AABenchmarkData,
} from './artificial-analysis';

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
  const entries: AAModelEntry[] = [
    {
      model_name: 'Claude Sonnet 4.5',
      provider_name: 'Anthropic',
      intelligence_index: 52.3,
      coding_score: 48.5,
      reasoning_score: 55.1,
      model_id: 'anthropic/claude-sonnet-4.5',
    },
    {
      model_name: 'GPT-4o',
      provider_name: 'OpenAI',
      intelligence_index: 38.2,
      coding_score: 35.0,
    },
    {
      model_name: 'No Data Model',
      provider_name: 'Unknown',
      // No intelligence_index or coding_score
    },
  ];

  it('builds lookup with multiple keys per entry', () => {
    const lookup = buildAALookup(entries);
    // Should find by normalized name
    expect(lookup.has('claude-sonnet-4.5')).toBe(true);
    // Should find by provider/name
    expect(lookup.has('anthropic/claude-sonnet-4.5')).toBe(true);
    // Should find by model_id
    expect(lookup.has('anthropic/claude-sonnet-4.5')).toBe(true);
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
    expect(sonnet!.reasoningScore).toBe(55.1);
    expect(sonnet!.aaModelName).toBe('Claude Sonnet 4.5');
  });
});

describe('matchModelToAA', () => {
  const aaEntries: AAModelEntry[] = [
    {
      model_name: 'Claude Sonnet 4.5',
      provider_name: 'Anthropic',
      intelligence_index: 52.3,
      coding_score: 48.5,
      model_id: 'anthropic/claude-sonnet-4.5',
    },
    {
      model_name: 'GPT-4o',
      provider_name: 'OpenAI',
      intelligence_index: 38.2,
      coding_score: 35.0,
    },
    {
      model_name: 'DeepSeek V3.2',
      provider_name: 'DeepSeek',
      intelligence_index: 45.0,
      coding_score: 42.0,
    },
    {
      model_name: 'Grok 4.1',
      provider_name: 'xAI',
      intelligence_index: 50.0,
      coding_score: 46.0,
    },
  ];

  const aaLookup = buildAALookup(aaEntries);

  it('matches by exact model ID', () => {
    const result = matchModelToAA('anthropic/claude-sonnet-4.5', 'Claude Sonnet 4.5', aaLookup);
    expect(result).toBeDefined();
    expect(result!.intelligenceIndex).toBe(52.3);
  });

  it('matches by normalized display name', () => {
    const result = matchModelToAA('openai/gpt-4o', 'GPT-4o', aaLookup);
    expect(result).toBeDefined();
    expect(result!.intelligenceIndex).toBe(38.2);
  });

  it('matches by stripped ID without provider', () => {
    const result = matchModelToAA('deepseek/deepseek-v3.2', 'DeepSeek V3.2', aaLookup);
    expect(result).toBeDefined();
    expect(result!.intelligenceIndex).toBe(45.0);
  });

  it('matches stripping :free suffix', () => {
    // Should match "gpt-4o" after stripping :free
    const result = matchModelToAA('openai/gpt-4o:free', 'GPT-4o (Free)', aaLookup);
    // The display name "GPT-4o (Free)" normalizes to "gpt-4o-free" which won't match,
    // but stripping :free from the ID gives "gpt-4o" which does
    expect(result).toBeDefined();
  });

  it('returns undefined for unknown models', () => {
    const result = matchModelToAA('unknown/model-xyz', 'Unknown Model XYZ', aaLookup);
    expect(result).toBeUndefined();
  });
});
