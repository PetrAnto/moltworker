/**
 * Tests for alias generation.
 */

import { describe, it, expect } from 'vitest';
import { generateAlias, collectExistingAliases } from './alias';

describe('generateAlias', () => {
  it('strips provider prefix', () => {
    const existing = new Set<string>();
    const aliasMap: Record<string, string> = {};
    const alias = generateAlias('openai/gpt-4o-2024-08-06', existing, aliasMap);
    expect(alias).not.toContain('openai');
    expect(alias).toContain('gpt');
  });

  it('removes :free suffix', () => {
    const existing = new Set<string>();
    const aliasMap: Record<string, string> = {};
    const alias = generateAlias('meta-llama/llama-4-maverick:free', existing, aliasMap);
    expect(alias).not.toContain('free');
    expect(alias).toContain('llama');
  });

  it('removes date suffixes', () => {
    const existing = new Set<string>();
    const aliasMap: Record<string, string> = {};
    const alias = generateAlias('anthropic/claude-sonnet-2025-01-15', existing, aliasMap);
    expect(alias).not.toMatch(/2025/);
  });

  it('resolves conflicts with counter', () => {
    const existing = new Set<string>(['gpt4o']);
    const aliasMap: Record<string, string> = {};
    const alias = generateAlias('openai/gpt-4o', existing, aliasMap);
    expect(alias).not.toBe('gpt4o');
    expect(existing.has(alias)).toBe(true);
  });

  it('generates aliases without hyphens (Telegram bot command compat)', () => {
    const existing = new Set<string>();
    const aliasMap: Record<string, string> = {};
    const alias = generateAlias('openai/gpt-4o-mini', existing, aliasMap);
    expect(alias).not.toContain('-');
  });

  it('sanitizes cached alias from map (strips hyphens)', () => {
    const existing = new Set<string>();
    const aliasMap: Record<string, string> = { 'openai/gpt-5': 'my-gpt5' };
    const alias = generateAlias('openai/gpt-5', existing, aliasMap);
    expect(alias).toBe('mygpt5');
    expect(aliasMap['openai/gpt-5']).toBe('mygpt5'); // Map updated in-place
  });

  it('returns clean cached alias unchanged', () => {
    const existing = new Set<string>();
    const aliasMap: Record<string, string> = { 'openai/gpt-5': 'mygpt5' };
    const alias = generateAlias('openai/gpt-5', existing, aliasMap);
    expect(alias).toBe('mygpt5');
    expect(aliasMap['openai/gpt-5']).toBe('mygpt5');
  });

  it('handles sanitized alias that collides with existing', () => {
    const existing = new Set<string>(['mygpt5']);
    const aliasMap: Record<string, string> = { 'openai/gpt-5': 'my-gpt5' };
    const alias = generateAlias('openai/gpt-5', existing, aliasMap);
    expect(alias).toBe('mygpt5'); // Assigned first wins
    expect(aliasMap['openai/gpt-5']).toBe('mygpt5');
  });

  it('adds generated alias to map for stability', () => {
    const existing = new Set<string>();
    const aliasMap: Record<string, string> = {};
    const alias = generateAlias('deepseek/deepseek-v3.2', existing, aliasMap);
    expect(aliasMap['deepseek/deepseek-v3.2']).toBe(alias);
  });

  it('generates lowercase aliases', () => {
    const existing = new Set<string>();
    const aliasMap: Record<string, string> = {};
    const alias = generateAlias('MistralAI/Mistral-Large-2512', existing, aliasMap);
    expect(alias).toBe(alias.toLowerCase());
  });

  it('truncates very long model IDs', () => {
    const existing = new Set<string>();
    const aliasMap: Record<string, string> = {};
    const alias = generateAlias('provider/super-ultra-mega-extremely-long-model-name-with-extra-details', existing, aliasMap);
    expect(alias.length).toBeLessThanOrEqual(24);
  });

  it('handles model IDs without provider prefix', () => {
    const existing = new Set<string>();
    const aliasMap: Record<string, string> = {};
    const alias = generateAlias('deepseek-chat', existing, aliasMap);
    expect(alias).toBeTruthy();
    expect(alias.length).toBeGreaterThan(0);
  });

  it('removes preview/latest/beta suffixes', () => {
    const existing = new Set<string>();
    const aliasMap: Record<string, string> = {};
    const alias = generateAlias('google/gemini-3-pro-preview', existing, aliasMap);
    expect(alias).not.toContain('preview');
  });

  it('produces readable aliases for GPT codex models', () => {
    const existing = new Set<string>();
    const aliasMap: Record<string, string> = {};
    const alias = generateAlias('openai/gpt-5.1-codex-mini', existing, aliasMap);
    expect(alias).toContain('gpt');
    expect(alias).toContain('codex');
    expect(alias).toContain('mini');
  });

  it('produces readable aliases for Gemini flash lite', () => {
    const existing = new Set<string>();
    const aliasMap: Record<string, string> = {};
    const alias = generateAlias('google/gemini-2.5-flash-lite-preview-09-2025', existing, aliasMap);
    expect(alias).toContain('gem');
    expect(alias).toContain('flash');
    expect(alias).toContain('lite');
    expect(alias).not.toContain('2025');
    expect(alias).not.toContain('preview');
  });

  it('produces readable aliases for Claude models', () => {
    const existing = new Set<string>();
    const aliasMap: Record<string, string> = {};
    const alias = generateAlias('anthropic/claude-opus-4.6', existing, aliasMap);
    expect(alias).toContain('claude');
    expect(alias).toContain('opus');
  });

  it('produces readable aliases for Qwen coder', () => {
    const existing = new Set<string>();
    const aliasMap: Record<string, string> = {};
    const alias = generateAlias('qwen/qwen-3-coder', existing, aliasMap);
    expect(alias).toContain('qwen');
    expect(alias).toContain('coder');
  });

  it('handles DeepSeek models with family abbreviation', () => {
    const existing = new Set<string>();
    const aliasMap: Record<string, string> = {};
    const alias = generateAlias('deepseek/deepseek-r1-0528', existing, aliasMap);
    expect(alias).toContain('ds');
  });

  it('keeps size indicators like 70b', () => {
    const existing = new Set<string>();
    const aliasMap: Record<string, string> = {};
    const alias = generateAlias('meta-llama/llama-4-70b', existing, aliasMap);
    expect(alias).toContain('70b');
  });
});

describe('collectExistingAliases', () => {
  it('collects aliases from both curated and dynamic models', () => {
    const curated = { gpt: {}, sonnet: {}, haiku: {} };
    const dynamic = { mymodel: {}, another: {} };
    const aliases = collectExistingAliases(curated, dynamic);
    expect(aliases.has('gpt')).toBe(true);
    expect(aliases.has('sonnet')).toBe(true);
    expect(aliases.has('mymodel')).toBe(true);
    expect(aliases.size).toBe(5);
  });

  it('handles empty inputs', () => {
    const aliases = collectExistingAliases({}, {});
    expect(aliases.size).toBe(0);
  });
});
