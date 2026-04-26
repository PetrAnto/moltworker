/**
 * Audit Skill — Parser bootstrap (web-tree-sitter)
 *
 * Wraps `web-tree-sitter` (emscripten-based, Worker-compatible at runtime)
 * with a thin facade so the rest of the Extractor stays free of emscripten
 * details.
 *
 * Three things to know:
 *
 *   1. `Parser.init()` is called once per isolate. The emscripten module
 *      stores its init promise internally; subsequent calls are cheap.
 *      In Cloudflare Workers we MUST pass the runtime tree-sitter.wasm
 *      bytes via `wasmBinary`, since locateFile() can't resolve file
 *      paths there. In Node tests, the package's `main` auto-resolves.
 *
 *   2. Init is STICKY: once called without bytes (Node-auto mode) the
 *      isolate cannot be repaired by a later call with bytes — the
 *      cached init promise wins. To prevent the "early code path poisons
 *      the isolate" failure mode, we record the init mode and refuse
 *      incompatible re-init attempts. Production code passes
 *      `requireRuntimeWasmBytes: true` to fail loudly on misuse.
 *
 *   3. `Language.load(bytes)` accepts a Uint8Array directly (web-tree-sitter
 *      0.20.x API, confirmed via tree-sitter-web.d.ts:140). Languages are
 *      cached per (lang, sha8) so repeated parses skip the load step.
 */

import Parser from 'web-tree-sitter';

import type { GrammarLanguage } from '../types';

// ---------------------------------------------------------------------------
// Init lifecycle
// ---------------------------------------------------------------------------

type InitMode = 'none' | 'node-auto' | 'wasmBinary';

let initPromise: Promise<void> | null = null;
let initMode: InitMode = 'none';

export interface BootstrapOptions {
  /**
   * Bytes of `web-tree-sitter/tree-sitter.wasm`. REQUIRED in Cloudflare
   * Workers (no file system); OPTIONAL in Node tests (auto-resolves).
   */
  runtimeWasmBytes?: ArrayBuffer | Uint8Array;
  /**
   * If true, throws when runtimeWasmBytes is missing. Production code paths
   * (the audit handler) MUST set this — if they don't have bytes to hand
   * over, the Worker would crash at init time anyway, so failing fast at
   * the typed boundary is friendlier than a stack trace from emscripten.
   */
  requireRuntimeWasmBytes?: boolean;
}

/**
 * Initialize the web-tree-sitter runtime. Idempotent — concurrent calls
 * share the single init promise. Throws if a later call asks for a mode
 * incompatible with the cached one (see "STICKY" note above).
 */
export async function bootstrapParser(opts: BootstrapOptions = {}): Promise<void> {
  const hasBytes = !!opts.runtimeWasmBytes;
  if (opts.requireRuntimeWasmBytes && !hasBytes) {
    throw new Error('[Parser] runtimeWasmBytes is required (Worker mode)');
  }
  if (initPromise) {
    // Sticky-init guard: a previous Node-auto init can't accept bytes after
    // the fact, and a previous wasmBinary init shouldn't be downgraded to
    // file-resolution either. Symmetric, loud, easy to debug.
    if (initMode === 'node-auto' && hasBytes) {
      throw new Error('[Parser] already initialized in node-auto mode; cannot retro-fit runtimeWasmBytes. Call _resetParserStateForTesting() or restart the isolate.');
    }
    if (initMode === 'wasmBinary' && !hasBytes && opts.requireRuntimeWasmBytes) {
      // Caller demanded strict mode but the isolate was already inited
      // without bytes (e.g. via test). Treat as misuse.
      throw new Error('[Parser] strict-mode call after non-strict init');
    }
    return initPromise;
  }
  initMode = hasBytes ? 'wasmBinary' : 'node-auto';
  const moduleOptions: Record<string, unknown> = {};
  if (hasBytes) moduleOptions.wasmBinary = opts.runtimeWasmBytes;
  initPromise = Parser.init(moduleOptions);
  return initPromise;
}

/** Test-only: clear the init promise + language cache between tests. */
export function _resetParserStateForTesting(): void {
  initPromise = null;
  initMode = 'none';
  languageCache.clear();
}

/** Test-only: peek at the current init mode. */
export function _initModeForTesting(): InitMode {
  return initMode;
}

// ---------------------------------------------------------------------------
// Language cache
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const languageCache = new Map<string, any>(); // value is web-tree-sitter Language

/**
 * Load a tree-sitter Language from raw WASM bytes (as supplied by
 * GrammarLoader.loadGrammar().bytes). Cached per (language, sha8).
 *
 * The `bootstrap` argument is forwarded to bootstrapParser() — REQUIRED in
 * Workers, optional in Node. Without this plumbing the Worker would call
 * Parser.init({}) and fail to find the runtime .wasm.
 */
export async function loadLanguage(
  language: GrammarLanguage,
  bytes: Uint8Array,
  sha256: string,
  bootstrap: BootstrapOptions = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const key = `${language}@${sha256.slice(0, 8)}`;
  const hit = languageCache.get(key);
  if (hit) return hit;

  await bootstrapParser(bootstrap);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lang = await (Parser as any).Language.load(bytes);
  languageCache.set(key, lang);
  return lang;
}

/**
 * Build a Parser bound to a Language. Each parse() call is independent —
 * we deliberately don't cache the Parser instance (web-tree-sitter parsers
 * are cheap to construct, tree-sitter trees own most of the state).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function newParserForLanguage(lang: any): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = new (Parser as any)();
  p.setLanguage(lang);
  return p;
}
