/**
 * Audit Skill — Bootstrap (in-Worker grammar uploader) tests
 *
 * Mocks fetch + R2 to exercise the bootstrap pipeline end-to-end:
 * idempotency, integrity checks, CDN fallback, error reporting, dry run.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import {
  bootstrapGrammars,
  renderBootstrapReport,
  TREE_SITTER_WASMS_VERSION,
  WEB_TREE_SITTER_VERSION,
} from './bootstrap';
import { _resetGrammarCachesForTesting } from './loader';
import { MVP_GRAMMARS, type GrammarManifest } from '../types';

// Smallest valid WASM header.
const WASM_BYTES = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface MockBucket {
  store: Map<string, Uint8Array>;
  putCalls: string[];
  getCalls: string[];
  putShouldFail?: Set<string>;
}

function createMockBucket(initial: Record<string, Uint8Array | string> = {}): {
  bucket: R2Bucket;
  state: MockBucket;
} {
  const store = new Map<string, Uint8Array>();
  for (const [k, v] of Object.entries(initial)) {
    store.set(k, typeof v === 'string' ? new TextEncoder().encode(v) : v);
  }
  const state: MockBucket = {
    store,
    putCalls: [],
    getCalls: [],
    putShouldFail: new Set(),
  };
  const bucket = {
    get: vi.fn(async (key: string) => {
      state.getCalls.push(key);
      const v = state.store.get(key);
      if (v === undefined) return null;
      return {
        async json() { return JSON.parse(new TextDecoder().decode(v)); },
        async arrayBuffer() { return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength); },
      };
    }),
    head: vi.fn(async (key: string) => {
      // Mirrors R2's head: returns metadata-only when present, null when not.
      // Used by bootstrap's self-heal path to detect a manifest entry whose
      // byte object has gone missing.
      const v = state.store.get(key);
      return v === undefined ? null : ({} as R2Object);
    }),
    put: vi.fn(async (key: string, value: ArrayBuffer | Uint8Array | string) => {
      state.putCalls.push(key);
      if (state.putShouldFail?.has(key)) {
        throw new Error('simulated R2 put failure');
      }
      const bytes = typeof value === 'string'
        ? new TextEncoder().encode(value)
        : value instanceof Uint8Array
          ? value
          : new Uint8Array(value);
      state.store.set(key, bytes);
      return {} as R2Object;
    }),
  } as unknown as R2Bucket;
  return { bucket, state };
}

/** Build a fetch mock that serves the WASM bytes for any supported URL. */
function makeFetchMock(opts: {
  bytes?: Uint8Array;
  failHostsOnce?: string[]; // CDN hostnames to 503 once before recovering
  failAlways?: string[];    // CDN hostnames to fail forever
} = {}): typeof fetch {
  const bytes = opts.bytes ?? WASM_BYTES;
  const failedOnce = new Set<string>();
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const host = new URL(url).hostname;
    if (opts.failAlways?.includes(host)) {
      return new Response('not found', { status: 404 });
    }
    if (opts.failHostsOnce?.includes(host) && !failedOnce.has(host)) {
      failedOnce.add(host);
      return new Response('temporary', { status: 503 });
    }
    // Slice into a fresh ArrayBuffer — Response's BodyInit signature is
    // narrower than Uint8Array under our DOM lib version.
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return new Response(ab, { status: 200, headers: { 'content-type': 'application/wasm' } });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  _resetGrammarCachesForTesting();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Cold start — no manifest in R2
// ---------------------------------------------------------------------------

describe('bootstrapGrammars — cold start', () => {
  it('uploads every MVP grammar + runtime + manifest on first run', async () => {
    const { bucket, state } = createMockBucket();
    const fetchImpl = makeFetchMock();

    const result = await bootstrapGrammars({ MOLTBOT_BUCKET: bucket }, { fetchImpl });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(result.manifestWritten).toBe(true);

    // Each grammar + the runtime should be marked uploaded.
    const grammarItems = result.items.filter((i) => i.kind === 'grammar' && i.language);
    expect(grammarItems.length).toBe(MVP_GRAMMARS.length);
    expect(grammarItems.every((i) => i.status === 'uploaded')).toBe(true);
    const runtimeItem = result.items.find((i) => i.kind === 'runtime');
    expect(runtimeItem?.status).toBe('uploaded');

    // R2 PUTs: 5 grammars + runtime + manifest = 7
    expect(state.putCalls.length).toBe(MVP_GRAMMARS.length + 2);
    expect(state.putCalls).toContain('audit/grammars/manifest.json');

    // Manifest content should round-trip through the loader's schema.
    const stored = state.store.get('audit/grammars/manifest.json')!;
    const parsed = JSON.parse(new TextDecoder().decode(stored)) as GrammarManifest;
    expect(parsed.version).toBe(1);
    expect(parsed.entries.length).toBe(MVP_GRAMMARS.length);
    expect(parsed.runtime).toBeDefined();
    // Sorted by language
    const langs = parsed.entries.map((e) => e.language);
    expect(langs).toEqual([...langs].sort());
  });

  it('uses the pinned upstream versions in the source tag', async () => {
    const { bucket, state } = createMockBucket();
    const fetchImpl = makeFetchMock();

    await bootstrapGrammars({ MOLTBOT_BUCKET: bucket }, { fetchImpl });
    const stored = state.store.get('audit/grammars/manifest.json')!;
    const parsed = JSON.parse(new TextDecoder().decode(stored)) as GrammarManifest;

    expect(parsed.entries[0].source).toBe(`tree-sitter-wasms@${TREE_SITTER_WASMS_VERSION}`);
    expect(parsed.runtime?.source).toBe(`web-tree-sitter@${WEB_TREE_SITTER_VERSION}`);
  });

  it('writes WASM under a key that encodes language + sha8', async () => {
    const { bucket, state } = createMockBucket();
    const fetchImpl = makeFetchMock();

    await bootstrapGrammars({ MOLTBOT_BUCKET: bucket }, { fetchImpl });
    const sha8 = sha256Hex(WASM_BYTES).slice(0, 8);
    expect(state.putCalls).toContain(`audit/grammars/typescript@${sha8}.wasm`);
    expect(state.putCalls).toContain(`audit/grammars/runtime@${sha8}.wasm`);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('bootstrapGrammars — idempotency', () => {
  it('does not re-upload unchanged grammars on a second run', async () => {
    const { bucket, state } = createMockBucket();
    const fetchImpl = makeFetchMock();

    await bootstrapGrammars({ MOLTBOT_BUCKET: bucket }, { fetchImpl });
    const firstRunPuts = state.putCalls.length;

    state.putCalls.length = 0;
    const second = await bootstrapGrammars({ MOLTBOT_BUCKET: bucket }, { fetchImpl });

    expect(firstRunPuts).toBeGreaterThan(0);
    // Second run: every grammar is unchanged, no PUTs.
    expect(state.putCalls).toEqual([]);
    expect(second.manifestWritten).toBe(false);
    const grammarItems = second.items.filter((i) => i.kind === 'grammar' && i.language);
    expect(grammarItems.every((i) => i.status === 'unchanged')).toBe(true);
  });

  it('self-heals when manifest references a byte object that is missing from R2', async () => {
    // Reproduces the production case observed on PetrAnto/wagmi: the
    // manifest survived from a prior upload but the per-language WASM
    // object was no longer in R2 (partial upload, manual prune, binding
    // swap, etc.). Pre-fix, bootstrap saw `prev.sha256 === sha`, declared
    // the entry "unchanged", wrote nothing, and the loader kept returning
    // null — every subsequent audit silently lost coverage for that
    // language.
    const { bucket, state } = createMockBucket();
    const fetchImpl = makeFetchMock();

    // First run: populates R2 with a complete manifest + bytes.
    await bootstrapGrammars({ MOLTBOT_BUCKET: bucket }, { fetchImpl });
    expect(state.store.has('audit/grammars/manifest.json')).toBe(true);
    const sha8 = sha256Hex(WASM_BYTES).slice(0, 8);
    const jsKey = `audit/grammars/javascript@${sha8}.wasm`;
    const tsxKey = `audit/grammars/tsx@${sha8}.wasm`;
    expect(state.store.has(jsKey)).toBe(true);
    expect(state.store.has(tsxKey)).toBe(true);

    // Simulate the broken state: drop the byte objects but keep the
    // manifest. This is what the production R2 looked like when the
    // user's audit complained "grammar(s) missing for javascript, tsx"
    // even though bootstrap reported every entry as unchanged.
    state.store.delete(jsKey);
    state.store.delete(tsxKey);
    state.putCalls.length = 0;

    const second = await bootstrapGrammars({ MOLTBOT_BUCKET: bucket }, { fetchImpl });

    // The two re-uploaded grammars should be marked `uploaded`, not
    // `unchanged` — and the actual byte objects should be back in R2.
    const jsItem = second.items.find(
      (i) => i.kind === 'grammar' && i.language === 'javascript',
    );
    const tsxItem = second.items.find(
      (i) => i.kind === 'grammar' && i.language === 'tsx',
    );
    expect(jsItem?.status).toBe('uploaded');
    expect(tsxItem?.status).toBe('uploaded');
    expect(state.putCalls).toContain(jsKey);
    expect(state.putCalls).toContain(tsxKey);
    expect(state.store.has(jsKey)).toBe(true);
    expect(state.store.has(tsxKey)).toBe(true);

    // The other grammars whose bytes were still present must remain
    // a no-op — we only re-upload what's missing.
    const otherItems = second.items.filter(
      (i) => i.kind === 'grammar' && i.language !== 'javascript' && i.language !== 'tsx',
    );
    expect(otherItems.every((i) => i.status === 'unchanged')).toBe(true);
  });

  it('self-heals when the runtime byte object is missing but the manifest entry remains', async () => {
    const { bucket, state } = createMockBucket();
    const fetchImpl = makeFetchMock();

    await bootstrapGrammars({ MOLTBOT_BUCKET: bucket }, { fetchImpl });
    const sha8 = sha256Hex(WASM_BYTES).slice(0, 8);
    const runtimeKey = `audit/grammars/runtime@${sha8}.wasm`;
    expect(state.store.has(runtimeKey)).toBe(true);

    state.store.delete(runtimeKey);
    state.putCalls.length = 0;

    const second = await bootstrapGrammars({ MOLTBOT_BUCKET: bucket }, { fetchImpl });

    const runtimeItem = second.items.find((i) => i.kind === 'runtime');
    expect(runtimeItem?.status).toBe('uploaded');
    expect(state.putCalls).toContain(runtimeKey);
    expect(state.store.has(runtimeKey)).toBe(true);
  });

  it('re-uploads when upstream bytes change', async () => {
    const { bucket, state } = createMockBucket();
    await bootstrapGrammars({ MOLTBOT_BUCKET: bucket }, { fetchImpl: makeFetchMock() });
    state.putCalls.length = 0;

    // Upstream now serves different bytes.
    const newBytes = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      // Trailing custom section (0x00 + length + name) — still valid WASM.
      0x00, 0x02, 0x01, 0x61,
    ]);
    const second = await bootstrapGrammars(
      { MOLTBOT_BUCKET: bucket },
      { fetchImpl: makeFetchMock({ bytes: newBytes }) },
    );

    expect(second.manifestWritten).toBe(true);
    // Every grammar + runtime + manifest re-uploaded (5+1+1=7).
    expect(state.putCalls.length).toBe(MVP_GRAMMARS.length + 2);
    const grammarItems = second.items.filter((i) => i.kind === 'grammar' && i.language);
    expect(grammarItems.every((i) => i.status === 'uploaded')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integrity guards
// ---------------------------------------------------------------------------

describe('bootstrapGrammars — integrity', () => {
  it('rejects non-WASM bytes from the CDN (magic header check)', async () => {
    const { bucket, state } = createMockBucket();
    // CDN returns an HTML error page instead of WASM.
    const html = new TextEncoder().encode('<html>not found</html>');
    const fetchImpl = makeFetchMock({ bytes: html });

    const result = await bootstrapGrammars({ MOLTBOT_BUCKET: bucket }, { fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.manifestWritten).toBe(false);
    expect(state.putCalls).toEqual([]); // nothing written on integrity failure
    const errors = result.items.filter((i) => i.status === 'error');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].error).toMatch(/magic|non-WASM/i);
  });

  it('falls back to unpkg if jsdelivr fails', async () => {
    const { bucket } = createMockBucket();
    const fetchImpl = makeFetchMock({ failAlways: ['cdn.jsdelivr.net'] });

    const result = await bootstrapGrammars({ MOLTBOT_BUCKET: bucket }, { fetchImpl });
    expect(result.ok).toBe(true);
    const items = result.items.filter((i) => i.source);
    expect(items.every((i) => i.source === 'unpkg')).toBe(true);
  });

  it('reports an error when both CDNs fail', async () => {
    const { bucket, state } = createMockBucket();
    const fetchImpl = makeFetchMock({
      failAlways: ['cdn.jsdelivr.net', 'unpkg.com'],
    });

    const result = await bootstrapGrammars({ MOLTBOT_BUCKET: bucket }, { fetchImpl });
    expect(result.ok).toBe(false);
    expect(state.putCalls).toEqual([]);
    expect(result.items.every((i) => i.status === 'error')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Dry-run mode
// ---------------------------------------------------------------------------

describe('bootstrapGrammars — dry run', () => {
  it('hashes + reports without writing to R2', async () => {
    const { bucket, state } = createMockBucket();
    const fetchImpl = makeFetchMock();

    const result = await bootstrapGrammars({ MOLTBOT_BUCKET: bucket }, { fetchImpl, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(state.putCalls).toEqual([]); // zero R2 writes
    expect(result.manifestWritten).toBe(false);

    // Every item still computed sha8 + size.
    const grammarItems = result.items.filter((i) => i.kind === 'grammar' && i.language);
    expect(grammarItems.length).toBe(MVP_GRAMMARS.length);
    expect(grammarItems.every((i) => typeof i.sha8 === 'string' && i.sha8.length === 8)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Misconfiguration
// ---------------------------------------------------------------------------

describe('bootstrapGrammars — misconfiguration', () => {
  it('errors clearly when MOLTBOT_BUCKET is missing', async () => {
    const result = await bootstrapGrammars({}, { fetchImpl: makeFetchMock() });
    expect(result.ok).toBe(false);
    expect(result.items[0].error).toMatch(/MOLTBOT_BUCKET/);
  });
});

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

describe('renderBootstrapReport', () => {
  it('renders a success summary with item lines', async () => {
    const { bucket } = createMockBucket();
    const result = await bootstrapGrammars(
      { MOLTBOT_BUCKET: bucket },
      { fetchImpl: makeFetchMock() },
    );
    const text = renderBootstrapReport(result);
    expect(text).toMatch(/✅|complete/i);
    expect(text).toContain('typescript');
    expect(text).toContain('runtime');
  });

  it('renders an error summary when bootstrap failed', () => {
    const text = renderBootstrapReport({
      ok: false, dryRun: false,
      items: [{ kind: 'grammar', language: 'typescript', status: 'error', error: 'boom' }],
      manifestWritten: false, bytesFetched: 0, durationMs: 5,
    });
    expect(text).toMatch(/⚠️|errors/);
    expect(text).toContain('boom');
  });

  it('marks dry runs in the header', () => {
    const text = renderBootstrapReport({
      ok: true, dryRun: true, items: [],
      manifestWritten: false, bytesFetched: 0, durationMs: 1,
    });
    expect(text).toMatch(/dry run/i);
  });
});
