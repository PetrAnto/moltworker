/**
 * Tests for Nexus KV cache
 */

import { describe, it, expect, vi } from 'vitest';
import { normalizeCacheKey, getCachedDossier, cacheDossier } from './cache';
import type { NexusDossier } from './types';

function createMockKV() {
  const store = new Map<string, { value: string; ttl?: number }>();
  return {
    get: vi.fn(async (key: string, type?: string) => {
      const entry = store.get(key);
      if (!entry) return null;
      if (type === 'json') return JSON.parse(entry.value);
      return entry.value;
    }),
    put: vi.fn(async (key: string, value: string, opts?: { expirationTtl?: number }) => {
      store.set(key, { value, ttl: opts?.expirationTtl });
    }),
    _store: store,
  } as unknown as KVNamespace & { _store: Map<string, { value: string; ttl?: number }> };
}

describe('normalizeCacheKey', () => {
  it('normalizes to lowercase with dashes', () => {
    expect(normalizeCacheKey('AI Trends 2026', 'quick')).toBe('nexus:quick:ai-trends-2026');
  });

  it('strips punctuation', () => {
    expect(normalizeCacheKey('What is AI?!', 'quick')).toBe('nexus:quick:what-is-ai');
  });

  it('collapses whitespace', () => {
    expect(normalizeCacheKey('  lots   of   spaces  ', 'decision')).toBe('nexus:decision:lots-of-spaces');
  });

  it('includes mode in key', () => {
    const quick = normalizeCacheKey('test', 'quick');
    const decision = normalizeCacheKey('test', 'decision');
    expect(quick).not.toBe(decision);
  });
});

describe('getCachedDossier', () => {
  it('returns null when KV is undefined', async () => {
    const result = await getCachedDossier(undefined, 'test', 'quick');
    expect(result).toBeNull();
  });

  it('returns cached dossier on hit', async () => {
    const kv = createMockKV();
    const dossier: NexusDossier = {
      query: 'test', mode: 'quick', synthesis: 'cached', evidence: [], createdAt: '2026-03-25',
    };
    await cacheDossier(kv, dossier);

    const result = await getCachedDossier(kv, 'test', 'quick');
    expect(result).not.toBeNull();
    expect(result!.synthesis).toBe('cached');
  });

  it('returns null on cache miss', async () => {
    const kv = createMockKV();
    const result = await getCachedDossier(kv, 'nonexistent', 'quick');
    expect(result).toBeNull();
  });
});

describe('cacheDossier', () => {
  it('stores with TTL', async () => {
    const kv = createMockKV();
    const dossier: NexusDossier = {
      query: 'test', mode: 'quick', synthesis: 'data', evidence: [], createdAt: '2026-03-25',
    };
    await cacheDossier(kv, dossier);

    const entry = kv._store.get('nexus:quick:test');
    expect(entry).toBeDefined();
    expect(entry!.ttl).toBe(4 * 60 * 60); // 4 hours
  });

  it('no-ops when KV is undefined', async () => {
    // Should not throw
    await cacheDossier(undefined, { query: 'test', mode: 'quick', synthesis: '', evidence: [], createdAt: '' });
  });
});
