/**
 * Audit Skill — Grammar Loader tests
 *
 * Mocks an R2Bucket and exercises the loader's caching, validation,
 * and graceful-degradation behaviors. Uses the smallest valid WASM
 * module (8 bytes: magic + version) so WebAssembly.compile() succeeds
 * without shipping any real grammar.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadGrammar, preloadGrammars, _resetGrammarCachesForTesting } from './loader';
import { MAX_GRAMMAR_BYTES, type GrammarManifest, type GrammarManifestEntry } from '../types';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** Smallest valid WASM: magic "\0asm" + version 1. */
const MIN_WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function makeEntry(
  language: GrammarManifestEntry['language'],
  bytes: Uint8Array = MIN_WASM,
): GrammarManifestEntry {
  const sha = sha256Hex(bytes);
  return {
    language,
    key: `audit/grammars/${language}@${sha.slice(0, 8)}.wasm`,
    sha256: sha,
    size: bytes.length,
    source: 'test',
    uploadedAt: '2026-04-26T00:00:00.000Z',
  };
}

function makeManifest(entries: GrammarManifestEntry[]): GrammarManifest {
  return { version: 1, entries, updatedAt: '2026-04-26T00:00:00.000Z' };
}

interface MockBucket {
  store: Map<string, Uint8Array | string>;
  getCalls: string[];
}

function createMockBucket(initial: Record<string, Uint8Array | string> = {}): {
  bucket: R2Bucket;
  state: MockBucket;
} {
  const state: MockBucket = {
    store: new Map(Object.entries(initial)),
    getCalls: [],
  };
  const bucket = {
    get: vi.fn(async (key: string) => {
      state.getCalls.push(key);
      const v = state.store.get(key);
      if (v === undefined) return null;
      // Mirror R2ObjectBody methods we use in the loader
      return {
        async json() { return JSON.parse(typeof v === 'string' ? v : new TextDecoder().decode(v)); },
        async arrayBuffer() {
          if (typeof v === 'string') return new TextEncoder().encode(v).buffer;
          return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
        },
      };
    }),
  } as unknown as R2Bucket;
  return { bucket, state };
}

beforeEach(() => {
  _resetGrammarCachesForTesting();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// loadGrammar — happy path + caching
// ---------------------------------------------------------------------------

describe('loadGrammar — happy path', () => {
  it('fetches manifest, fetches blob, compiles, returns module', async () => {
    const entry = makeEntry('typescript');
    const { bucket, state } = createMockBucket({
      'audit/grammars/manifest.json': JSON.stringify(makeManifest([entry])),
      [entry.key]: MIN_WASM,
    });

    const result = await loadGrammar({ MOLTBOT_BUCKET: bucket }, 'typescript');
    expect(result).not.toBeNull();
    expect(result!.entry.language).toBe('typescript');
    expect(result!.cached).toBe(false);
    expect(result!.module).toBeInstanceOf(WebAssembly.Module);
    // Manifest + blob = 2 R2 reads
    expect(state.getCalls).toEqual(['audit/grammars/manifest.json', entry.key]);
  });

  it('reuses the cached compiled module on second call', async () => {
    const entry = makeEntry('typescript');
    const { bucket, state } = createMockBucket({
      'audit/grammars/manifest.json': JSON.stringify(makeManifest([entry])),
      [entry.key]: MIN_WASM,
    });

    const r1 = await loadGrammar({ MOLTBOT_BUCKET: bucket }, 'typescript');
    const r2 = await loadGrammar({ MOLTBOT_BUCKET: bucket }, 'typescript');
    expect(r1!.module).toBe(r2!.module); // identity, not just equality
    expect(r1!.cached).toBe(false);
    expect(r2!.cached).toBe(true);
    // Manifest cached too: 2 calls in run 1, 0 in run 2
    expect(state.getCalls.length).toBe(2);
  });

  it('serves manifest from cache across different language loads', async () => {
    const ts = makeEntry('typescript');
    const py = makeEntry('python');
    const { bucket, state } = createMockBucket({
      'audit/grammars/manifest.json': JSON.stringify(makeManifest([ts, py])),
      [ts.key]: MIN_WASM,
      [py.key]: MIN_WASM,
    });

    await loadGrammar({ MOLTBOT_BUCKET: bucket }, 'typescript');
    await loadGrammar({ MOLTBOT_BUCKET: bucket }, 'python');
    // Manifest fetched once, blobs fetched once each = 3 total
    expect(state.getCalls).toEqual([
      'audit/grammars/manifest.json',
      ts.key,
      py.key,
    ]);
  });
});

// ---------------------------------------------------------------------------
// loadGrammar — graceful degradation
// ---------------------------------------------------------------------------

describe('loadGrammar — graceful degradation', () => {
  it('returns null when MOLTBOT_BUCKET is not configured', async () => {
    const result = await loadGrammar({}, 'typescript');
    expect(result).toBeNull();
  });

  it('returns null when manifest is absent', async () => {
    const { bucket } = createMockBucket(); // empty
    const result = await loadGrammar({ MOLTBOT_BUCKET: bucket }, 'typescript');
    expect(result).toBeNull();
  });

  it('returns null when manifest JSON is malformed', async () => {
    const { bucket } = createMockBucket({
      'audit/grammars/manifest.json': '{ not valid json',
    });
    const result = await loadGrammar({ MOLTBOT_BUCKET: bucket }, 'typescript');
    expect(result).toBeNull();
  });

  it('returns null when manifest fails schema validation', async () => {
    const { bucket } = createMockBucket({
      'audit/grammars/manifest.json': JSON.stringify({ version: 999, entries: [] }),
    });
    const result = await loadGrammar({ MOLTBOT_BUCKET: bucket }, 'typescript');
    expect(result).toBeNull();
  });

  it('returns null when the requested language has no manifest entry', async () => {
    const ts = makeEntry('typescript');
    const { bucket } = createMockBucket({
      'audit/grammars/manifest.json': JSON.stringify(makeManifest([ts])),
      [ts.key]: MIN_WASM,
    });
    const result = await loadGrammar({ MOLTBOT_BUCKET: bucket }, 'go');
    expect(result).toBeNull();
  });

  it('returns null when the WASM blob is missing in R2', async () => {
    const ts = makeEntry('typescript');
    // Manifest references the key but the blob isn't there
    const { bucket } = createMockBucket({
      'audit/grammars/manifest.json': JSON.stringify(makeManifest([ts])),
    });
    const result = await loadGrammar({ MOLTBOT_BUCKET: bucket }, 'typescript');
    expect(result).toBeNull();
  });

  it('returns null when the manifest declares a size > MAX_GRAMMAR_BYTES', async () => {
    const ts = makeEntry('typescript');
    const oversized = { ...ts, size: MAX_GRAMMAR_BYTES + 1 };
    const { bucket } = createMockBucket({
      'audit/grammars/manifest.json': JSON.stringify(makeManifest([oversized])),
      [ts.key]: MIN_WASM,
    });
    const result = await loadGrammar({ MOLTBOT_BUCKET: bucket }, 'typescript');
    expect(result).toBeNull();
  });

  it('returns null on compile failure (corrupt WASM)', async () => {
    // Valid SHA + size, but the bytes themselves are not valid WASM
    const corrupt = new TextEncoder().encode('not a wasm');
    const entry: GrammarManifestEntry = {
      language: 'typescript',
      key: `audit/grammars/typescript@${sha256Hex(corrupt).slice(0, 8)}.wasm`,
      sha256: sha256Hex(corrupt),
      size: corrupt.length,
      source: 'test',
      uploadedAt: '2026-04-26T00:00:00.000Z',
    };
    const { bucket } = createMockBucket({
      'audit/grammars/manifest.json': JSON.stringify(makeManifest([entry])),
      [entry.key]: corrupt,
    });
    const result = await loadGrammar({ MOLTBOT_BUCKET: bucket }, 'typescript');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Manifest validation edge cases
// ---------------------------------------------------------------------------

describe('manifest schema validation', () => {
  it('rejects entries with non-hex SHA', async () => {
    const bad = {
      language: 'typescript',
      key: 'audit/grammars/typescript@xxxxxxxx.wasm',
      sha256: 'not-a-real-hex-string',
      size: 8,
      source: 'test',
      uploadedAt: '2026-04-26T00:00:00.000Z',
    };
    const { bucket } = createMockBucket({
      'audit/grammars/manifest.json': JSON.stringify({ version: 1, entries: [bad], updatedAt: 'now' }),
    });
    const result = await loadGrammar({ MOLTBOT_BUCKET: bucket }, 'typescript');
    expect(result).toBeNull();
  });

  it('rejects entries with non-positive size', async () => {
    const ts = makeEntry('typescript');
    const bad = { ...ts, size: 0 };
    const { bucket } = createMockBucket({
      'audit/grammars/manifest.json': JSON.stringify({ version: 1, entries: [bad], updatedAt: 'now' }),
    });
    const result = await loadGrammar({ MOLTBOT_BUCKET: bucket }, 'typescript');
    expect(result).toBeNull();
  });

  it('rejects entries whose key does not start with audit/grammars/', async () => {
    const ts = makeEntry('typescript');
    const bad = { ...ts, key: 'wrong/path/typescript.wasm' };
    const { bucket } = createMockBucket({
      'audit/grammars/manifest.json': JSON.stringify({ version: 1, entries: [bad], updatedAt: 'now' }),
    });
    const result = await loadGrammar({ MOLTBOT_BUCKET: bucket }, 'typescript');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// preloadGrammars
// ---------------------------------------------------------------------------

describe('preloadGrammars', () => {
  it('returns the set of languages that loaded successfully', async () => {
    const ts = makeEntry('typescript');
    const go = makeEntry('go');
    const { bucket } = createMockBucket({
      'audit/grammars/manifest.json': JSON.stringify(makeManifest([ts, go])),
      [ts.key]: MIN_WASM,
      [go.key]: MIN_WASM,
      // python intentionally missing
    });

    const ok = await preloadGrammars({ MOLTBOT_BUCKET: bucket }, ['typescript', 'python', 'go']);
    expect([...ok].sort()).toEqual(['go', 'typescript']);
  });

  it('returns empty set when manifest is missing', async () => {
    const { bucket } = createMockBucket();
    const ok = await preloadGrammars({ MOLTBOT_BUCKET: bucket }, ['typescript']);
    expect(ok.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Hardening — fixes from GPT review of slice 1
// ---------------------------------------------------------------------------

describe('SHA-256 integrity verification (security fix)', () => {
  it('returns null when R2 object SHA does not match manifest SHA', async () => {
    // Manifest claims MIN_WASM's SHA but R2 has a different (still valid) WASM.
    const entry = makeEntry('typescript', MIN_WASM);
    const tampered = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x00]);

    const { bucket } = createMockBucket({
      'audit/grammars/manifest.json': JSON.stringify(makeManifest([entry])),
      [entry.key]: tampered,
    });
    const result = await loadGrammar({ MOLTBOT_BUCKET: bucket }, 'typescript');
    expect(result).toBeNull();
  });

  it('still loads when the SHA matches (positive control)', async () => {
    const entry = makeEntry('typescript', MIN_WASM);
    const { bucket } = createMockBucket({
      'audit/grammars/manifest.json': JSON.stringify(makeManifest([entry])),
      [entry.key]: MIN_WASM,
    });
    const result = await loadGrammar({ MOLTBOT_BUCKET: bucket }, 'typescript');
    expect(result).not.toBeNull();
  });
});

describe('manifest cache TTL (resilience fix)', () => {
  it('refetches the manifest after the TTL elapses, picking up new entries', async () => {
    vi.useFakeTimers();
    try {
      const ts = makeEntry('typescript');
      const py = makeEntry('python');

      // Round 1: manifest only has typescript
      const round1 = createMockBucket({
        'audit/grammars/manifest.json': JSON.stringify(makeManifest([ts])),
        [ts.key]: MIN_WASM,
      });
      vi.stubGlobal('crypto', globalThis.crypto);
      const r1 = await loadGrammar({ MOLTBOT_BUCKET: round1.bucket }, 'python');
      expect(r1).toBeNull(); // python not yet in manifest

      // Advance past TTL
      await vi.advanceTimersByTimeAsync(11 * 60 * 1000);

      // Round 2: same isolate, but bucket now has both entries
      const round2 = createMockBucket({
        'audit/grammars/manifest.json': JSON.stringify(makeManifest([ts, py])),
        [ts.key]: MIN_WASM,
        [py.key]: MIN_WASM,
      });
      const r2 = await loadGrammar({ MOLTBOT_BUCKET: round2.bucket }, 'python');
      expect(r2).not.toBeNull();
      expect(r2!.entry.language).toBe('python');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT refetch within the TTL window', async () => {
    vi.useFakeTimers();
    try {
      const ts = makeEntry('typescript');
      const { bucket, state } = createMockBucket({
        'audit/grammars/manifest.json': JSON.stringify(makeManifest([ts])),
        [ts.key]: MIN_WASM,
      });
      await loadGrammar({ MOLTBOT_BUCKET: bucket }, 'typescript');
      const callsAfterFirst = state.getCalls.length;

      await vi.advanceTimersByTimeAsync(60 * 1000); // 1 minute, well under 10
      await loadGrammar({ MOLTBOT_BUCKET: bucket }, 'typescript');
      // No new manifest read (cached); module also cached → no growth at all
      expect(state.getCalls.length).toBe(callsAfterFirst);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('manifest key prefix validation (correctness fix)', () => {
  function rejectFixture(badKey: string) {
    const ts = makeEntry('typescript');
    const bad = { ...ts, key: badKey };
    return createMockBucket({
      'audit/grammars/manifest.json': JSON.stringify({ version: 1, entries: [bad], updatedAt: 'now' }),
    });
  }

  it('rejects manifest where key encodes a different language', async () => {
    const ts = makeEntry('typescript');
    // Key claims python but entry is for typescript — language↔key mismatch
    const { bucket } = rejectFixture(`audit/grammars/python@${ts.sha256.slice(0, 8)}.wasm`);
    const result = await loadGrammar({ MOLTBOT_BUCKET: bucket }, 'typescript');
    expect(result).toBeNull();
  });

  it('rejects manifest where key encodes a different SHA prefix', async () => {
    const { bucket } = rejectFixture('audit/grammars/typescript@deadbeef.wasm');
    const result = await loadGrammar({ MOLTBOT_BUCKET: bucket }, 'typescript');
    expect(result).toBeNull();
  });

  it('rejects manifest where key has the wrong extension', async () => {
    const ts = makeEntry('typescript');
    const { bucket } = rejectFixture(`audit/grammars/typescript@${ts.sha256.slice(0, 8)}.bin`);
    const result = await loadGrammar({ MOLTBOT_BUCKET: bucket }, 'typescript');
    expect(result).toBeNull();
  });

  it('accepts a key that correctly encodes language + sha8 + .wasm (positive control)', async () => {
    const ts = makeEntry('typescript');
    const { bucket } = createMockBucket({
      'audit/grammars/manifest.json': JSON.stringify(makeManifest([ts])),
      [ts.key]: MIN_WASM,
    });
    const result = await loadGrammar({ MOLTBOT_BUCKET: bucket }, 'typescript');
    expect(result).not.toBeNull();
  });
});
