/**
 * Tests for model enrichment pipeline.
 */
import { describe, it, expect } from 'vitest';
import { computeOrchestraReady } from './enrich';
import type { ModelInfo } from '../models';
import type { AABenchmarkData } from './artificial-analysis';

function makeModel(overrides: Partial<ModelInfo>): ModelInfo {
  return {
    id: 'test/model',
    alias: 'test',
    name: 'Test Model',
    specialty: 'Test',
    score: 'test',
    cost: '$1/$2',
    ...overrides,
  };
}

function makeAAData(overrides: Partial<AABenchmarkData>): AABenchmarkData {
  return {
    intelligenceIndex: 0,
    aaModelName: 'Test',
    aaCreator: 'Test',
    aaSlug: 'test',
    ...overrides,
  };
}

describe('computeOrchestraReady', () => {
  it('requires tool support', () => {
    const model = makeModel({ supportsTools: false, maxContext: 128000 });
    expect(computeOrchestraReady(model)).toBe(false);
  });

  it('rejects image gen models', () => {
    const model = makeModel({ supportsTools: true, isImageGen: true, maxContext: 128000 });
    expect(computeOrchestraReady(model)).toBe(false);
  });

  it('requires >= 64K context', () => {
    const model = makeModel({ supportsTools: true, maxContext: 32000 });
    expect(computeOrchestraReady(model)).toBe(false);
  });

  it('marks orchestra-ready with high AA coding score', () => {
    const model = makeModel({ supportsTools: true, maxContext: 128000 });
    const aa = makeAAData({ codingScore: 50, intelligenceIndex: 40 });
    expect(computeOrchestraReady(model, aa)).toBe(true);
  });

  it('marks orchestra-ready with high LiveCodeBench score', () => {
    const model = makeModel({ supportsTools: true, maxContext: 128000 });
    const aa = makeAAData({ livecodebench: 50, intelligenceIndex: 40 });
    expect(computeOrchestraReady(model, aa)).toBe(true);
  });

  it('marks orchestra-ready with high intelligence index', () => {
    const model = makeModel({ supportsTools: true, maxContext: 128000 });
    const aa = makeAAData({ intelligenceIndex: 50 });
    expect(computeOrchestraReady(model, aa)).toBe(true);
  });

  it('uses heuristic fallback for agentic models', () => {
    const model = makeModel({
      supportsTools: true,
      maxContext: 128000,
      specialty: 'Agentic Coding',
    });
    expect(computeOrchestraReady(model)).toBe(true);
  });

  it('uses heuristic for known strong model families', () => {
    const model = makeModel({
      id: 'anthropic/claude-sonnet-4.5',
      supportsTools: true,
      maxContext: 200000,
    });
    expect(computeOrchestraReady(model)).toBe(true);
  });

  it('rejects small context models even with tools', () => {
    const model = makeModel({
      supportsTools: true,
      maxContext: 32000,
      specialty: 'Agentic Coding',
    });
    expect(computeOrchestraReady(model)).toBe(false);
  });

  it('rejects codex models even with good benchmarks', () => {
    const model = makeModel({
      id: 'openai/gpt-5.1-codex-mini-2025-11-13',
      supportsTools: true,
      maxContext: 200000,
      name: 'GPT-5.1 Codex Mini',
    });
    const aa = makeAAData({ codingScore: 60, intelligenceIndex: 50 });
    expect(computeOrchestraReady(model, aa)).toBe(false);
  });

  it('rejects models with low AA scores and no heuristic match', () => {
    const model = makeModel({
      id: 'unknown/weak-model',
      supportsTools: true,
      maxContext: 128000,
      specialty: 'General',
      name: 'Weak Model',
    });
    const aa = makeAAData({ codingScore: 10, livecodebench: 15, intelligenceIndex: 15 });
    expect(computeOrchestraReady(model, aa)).toBe(false);
  });
});
