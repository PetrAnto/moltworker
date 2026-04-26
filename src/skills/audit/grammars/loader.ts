/**
 * Audit Skill — Grammar Loader (R2-backed, isolate-cached)
 *
 * Loads tree-sitter WASM grammars from MOLTBOT_BUCKET. Compiled
 * `WebAssembly.Module` is cached in a module-scope Map keyed by
 * (language, sha8) so the second parse in the same Worker isolate is
 * zero-cost. The Extractor consumes this loader; this file deliberately
 * does NOT depend on web-tree-sitter — it's just bytes → compiled module.
 *
 * Invariants:
 *   - No fallback if a grammar is missing. We return null and let the
 *     caller skip that language gracefully.
 *   - Hard size cap (MAX_GRAMMAR_BYTES) before compile.
 *   - Manifest is fetched once per isolate, then cached.
 *   - Cache key includes sha256 prefix → swapping a grammar version forces
 *     fresh compile.
 */

import {
  type GrammarLanguage,
  type GrammarManifest,
  type GrammarManifestEntry,
  type RuntimeManifestEntry,
  MAX_GRAMMAR_BYTES,
  MAX_TREE_SITTER_RUNTIME_BYTES,
  isGrammarLanguage,
} from '../types';

const MANIFEST_KEY = 'audit/grammars/manifest.json';

// ---------------------------------------------------------------------------
// Isolate-scoped caches
// ---------------------------------------------------------------------------
//
// Module-scope state is per-Worker-isolate. Cloudflare may evict an isolate
// at any time, but while it lives the cache holds. This is the same pattern
// the runtime uses for compiled tool schemas elsewhere.
//
// Manifest cache has a TTL so a freshly-uploaded grammar becomes visible
// within MANIFEST_CACHE_TTL_MS even on isolates that loaded an older
// manifest. Compiled-module cache has no TTL — it's keyed by content SHA,
// so a grammar version bump produces a different cache key automatically.

interface CachedManifest {
  value: GrammarManifest;
  fetchedAt: number;
}

interface CachedGrammar {
  /** SHA-256-verified WASM bytes. Required by web-tree-sitter's
   *  `Language.load(Uint8Array)`, which does its own internal compile. */
  bytes: Uint8Array;
  /** Pre-compiled module from `WebAssembly.compile`. Kept for callers that
   *  can use it directly without going through web-tree-sitter (none yet,
   *  but the API contract preserves the option). */
  module: WebAssembly.Module;
}

/** Cached runtime WASM bytes. Same SHA-verified content-addressed pattern. */
interface CachedRuntime {
  bytes: Uint8Array;
  entry: RuntimeManifestEntry;
}

const MANIFEST_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

let manifestCache: CachedManifest | null = null;
const grammarCache = new Map<string, CachedGrammar>(); // key = `${lang}@${sha8}`
let runtimeCache: CachedRuntime | null = null;

/** Test-only: clear caches between tests. Not exported via index/types. */
export function _resetGrammarCachesForTesting(): void {
  manifestCache = null;
  grammarCache.clear();
  runtimeCache = null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface GrammarLoaderEnv {
  /** R2 bucket holding manifest + grammar blobs. */
  MOLTBOT_BUCKET?: R2Bucket;
}

export interface LoadResult {
  /** SHA-256-verified WASM bytes. Pass to `Parser.Language.load(bytes)`. */
  bytes: Uint8Array;
  /** Pre-compiled module. Same content as `bytes`; kept for forward-looking
   *  consumers that can bypass web-tree-sitter's internal compile. */
  module: WebAssembly.Module;
  /** The manifest entry that was used (handy for telemetry). */
  entry: GrammarManifestEntry;
  /** Whether this came from the isolate cache (cheap) or a cold fetch+compile. */
  cached: boolean;
}

/**
 * Load and compile the tree-sitter grammar for a language. Returns null if:
 *  - MOLTBOT_BUCKET is not configured
 *  - the manifest is missing
 *  - the language has no manifest entry
 *  - the WASM blob is missing in R2
 *  - the blob exceeds MAX_GRAMMAR_BYTES
 *  - the compile fails (logged, not thrown)
 *
 * The caller is expected to skip a missing language and continue with
 * others, surfacing a "language X unsupported" note in the audit plan.
 */
export async function loadGrammar(
  env: GrammarLoaderEnv,
  language: GrammarLanguage,
): Promise<LoadResult | null> {
  if (!env.MOLTBOT_BUCKET) {
    console.warn('[GrammarLoader] MOLTBOT_BUCKET not configured');
    return null;
  }
  if (!isGrammarLanguage(language)) {
    console.warn(`[GrammarLoader] not a known grammar language: ${language}`);
    return null;
  }

  const manifest = await getManifest(env.MOLTBOT_BUCKET);
  if (!manifest) return null;

  const entry = manifest.entries.find(e => e.language === language);
  if (!entry) {
    console.warn(`[GrammarLoader] manifest has no entry for "${language}"`);
    return null;
  }

  if (entry.size > MAX_GRAMMAR_BYTES) {
    console.warn(`[GrammarLoader] grammar "${language}" rejected: ${entry.size} bytes > ${MAX_GRAMMAR_BYTES}`);
    return null;
  }

  const cacheKey = `${entry.language}@${entry.sha256.slice(0, 8)}`;
  const cached = grammarCache.get(cacheKey);
  if (cached) {
    return { bytes: cached.bytes, module: cached.module, entry, cached: true };
  }

  const obj = await env.MOLTBOT_BUCKET.get(entry.key);
  if (!obj) {
    console.warn(`[GrammarLoader] R2 object missing: ${entry.key}`);
    return null;
  }
  const buffer = await obj.arrayBuffer();
  if (buffer.byteLength > MAX_GRAMMAR_BYTES) {
    console.warn(`[GrammarLoader] R2 object size (${buffer.byteLength}) exceeds cap`);
    return null;
  }

  // Integrity check: hash the actual bytes and compare against the manifest.
  // The manifest is content-addressed by design; without this verification
  // the cache key (sha8 prefix) and the bytes can drift apart silently after
  // an R2 overwrite or cross-upload, weakening the supply-chain guarantee.
  const actualSha = await sha256Hex(buffer);
  if (actualSha !== entry.sha256) {
    console.warn(
      `[GrammarLoader] SHA mismatch for "${language}": manifest claims ${entry.sha256}, R2 bytes are ${actualSha}. Refusing to compile.`,
    );
    return null;
  }

  let module: WebAssembly.Module;
  try {
    module = await WebAssembly.compile(buffer);
  } catch (err) {
    console.error(`[GrammarLoader] WebAssembly.compile failed for "${language}":`, err);
    return null;
  }

  const bytes = new Uint8Array(buffer);
  grammarCache.set(cacheKey, { bytes, module });
  return { bytes, module, entry, cached: false };
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const view = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < view.length; i++) {
    out += view[i].toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Load the web-tree-sitter runtime WASM bytes from R2. Same SHA-verified
 * content-addressed pattern as grammars. Returns a discriminated result
 * so the caller can distinguish "R2 not configured" from "R2 configured
 * but the runtime entry failed SHA verification" — operators looking at
 * a "runtime: bundled" report want to know which one they're seeing.
 * Closes GPT slice-5 review finding 2.
 */
export type RuntimeLoadFailure =
  | 'no_bucket'         // env.MOLTBOT_BUCKET is undefined
  | 'no_manifest'       // manifest fetch failed / not found
  | 'missing_runtime'   // manifest exists but has no runtime entry
  | 'oversize_declared' // manifest's declared size exceeds the cap
  | 'missing_object'    // R2 object missing despite a manifest entry
  | 'oversize_bytes'    // R2 bytes exceed the cap (manifest lied)
  | 'sha_mismatch';     // R2 bytes don't match the manifest SHA

export type RuntimeLoadResult =
  | { ok: true; bytes: Uint8Array; entry: RuntimeManifestEntry; cached: boolean }
  | { ok: false; reason: RuntimeLoadFailure };

export async function loadRuntimeWasm(env: GrammarLoaderEnv): Promise<RuntimeLoadResult> {
  if (!env.MOLTBOT_BUCKET) return { ok: false, reason: 'no_bucket' };
  const manifest = await getManifest(env.MOLTBOT_BUCKET);
  if (!manifest) return { ok: false, reason: 'no_manifest' };
  if (!manifest.runtime) return { ok: false, reason: 'missing_runtime' };
  const entry = manifest.runtime;

  if (entry.size > MAX_TREE_SITTER_RUNTIME_BYTES) {
    console.warn(`[GrammarLoader] runtime WASM rejected: ${entry.size} bytes > MAX_TREE_SITTER_RUNTIME_BYTES`);
    return { ok: false, reason: 'oversize_declared' };
  }

  if (runtimeCache && runtimeCache.entry.sha256 === entry.sha256) {
    return { ok: true, bytes: runtimeCache.bytes, entry: runtimeCache.entry, cached: true };
  }

  const obj = await env.MOLTBOT_BUCKET.get(entry.key);
  if (!obj) {
    console.warn(`[GrammarLoader] runtime R2 object missing: ${entry.key}`);
    return { ok: false, reason: 'missing_object' };
  }
  const buffer = await obj.arrayBuffer();
  if (buffer.byteLength > MAX_TREE_SITTER_RUNTIME_BYTES) {
    console.warn(`[GrammarLoader] runtime WASM bytes (${buffer.byteLength}) exceed MAX_TREE_SITTER_RUNTIME_BYTES`);
    return { ok: false, reason: 'oversize_bytes' };
  }

  const actualSha = await sha256Hex(buffer);
  if (actualSha !== entry.sha256) {
    console.warn(`[GrammarLoader] runtime SHA mismatch: manifest ${entry.sha256}, R2 ${actualSha}. Refusing.`);
    return { ok: false, reason: 'sha_mismatch' };
  }

  const bytes = new Uint8Array(buffer);
  runtimeCache = { bytes, entry };
  return { ok: true, bytes, entry, cached: false };
}

/**
 * Pre-warm grammars in parallel. Returns the set of languages that loaded
 * successfully so the Extractor can skip the rest. Does not throw on
 * partial failure — best-effort.
 */
export async function preloadGrammars(
  env: GrammarLoaderEnv,
  languages: ReadonlyArray<GrammarLanguage>,
): Promise<Set<GrammarLanguage>> {
  const results = await Promise.all(
    languages.map(async (lang) => ({ lang, result: await loadGrammar(env, lang) })),
  );
  const ok = new Set<GrammarLanguage>();
  for (const r of results) {
    if (r.result) ok.add(r.lang);
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Manifest fetch + validation
// ---------------------------------------------------------------------------

async function getManifest(bucket: R2Bucket): Promise<GrammarManifest | null> {
  if (manifestCache && Date.now() - manifestCache.fetchedAt < MANIFEST_CACHE_TTL_MS) {
    return manifestCache.value;
  }

  let obj: R2ObjectBody | null;
  try {
    obj = await bucket.get(MANIFEST_KEY);
  } catch (err) {
    console.error('[GrammarLoader] manifest fetch failed:', err);
    return null;
  }
  if (!obj) {
    console.warn(`[GrammarLoader] manifest missing at R2 key "${MANIFEST_KEY}". Run scripts/upload-audit-grammars.mjs first.`);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = await obj.json();
  } catch (err) {
    console.error('[GrammarLoader] manifest is not valid JSON:', err);
    return null;
  }
  if (!isManifest(parsed)) {
    console.error('[GrammarLoader] manifest failed schema validation');
    return null;
  }

  manifestCache = { value: parsed, fetchedAt: Date.now() };
  return parsed;
}

function isManifest(v: unknown): v is GrammarManifest {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Partial<GrammarManifest>;
  if (m.version !== 1) return false;
  if (typeof m.updatedAt !== 'string') return false;
  if (!Array.isArray(m.entries)) return false;
  if (!m.entries.every(isManifestEntry)) return false;
  // runtime is optional (back-compat with manifests written before the
  // runtime-bytes-via-R2 wiring).
  if (m.runtime !== undefined && !isRuntimeEntry(m.runtime)) return false;
  return true;
}

function isRuntimeEntry(v: unknown): v is RuntimeManifestEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Partial<RuntimeManifestEntry>;
  if (typeof e.key !== 'string') return false;
  if (typeof e.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(e.sha256)) return false;
  if (typeof e.size !== 'number' || !Number.isInteger(e.size) || e.size <= 0) return false;
  if (typeof e.source !== 'string') return false;
  if (typeof e.uploadedAt !== 'string') return false;
  // Key MUST encode `runtime@<sha8>.wasm` so the manifest can't lie about
  // what's stored where.
  const expectedPrefix = `audit/grammars/runtime@${e.sha256.slice(0, 8)}`;
  if (!e.key.startsWith(expectedPrefix) || !e.key.endsWith('.wasm')) return false;
  return true;
}

function isManifestEntry(v: unknown): v is GrammarManifestEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Partial<GrammarManifestEntry>;
  if (!isGrammarLanguage(e.language)) return false;
  if (typeof e.key !== 'string') return false;
  if (typeof e.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(e.sha256)) return false;
  if (typeof e.size !== 'number' || !Number.isInteger(e.size) || e.size <= 0) return false;
  if (typeof e.source !== 'string') return false;
  if (typeof e.uploadedAt !== 'string') return false;
  // Key MUST encode language + sha8 + .wasm. Without this, a malformed manifest
  // could route typescript -> python@<sha>.wasm and the loader would happily
  // serve the wrong grammar (the SHA verification would catch the bytes, but
  // the manifest claim itself is still incoherent and we want to reject it
  // at validation time).
  const expectedPrefix = `audit/grammars/${e.language}@${e.sha256.slice(0, 8)}`;
  if (!e.key.startsWith(expectedPrefix) || !e.key.endsWith('.wasm')) return false;
  return true;
}
