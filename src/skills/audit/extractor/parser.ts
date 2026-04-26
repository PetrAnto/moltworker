/**
 * Audit Skill — Parser bootstrap (web-tree-sitter)
 *
 * Wraps `web-tree-sitter` (emscripten-based, Worker-compatible at runtime)
 * with a thin facade so the rest of the Extractor stays free of emscripten
 * details. Two key bits:
 *
 *   1. `Parser.init()` is called once per isolate. The emscripten module
 *      stores its init promise internally, so subsequent calls are cheap.
 *      In Worker production we MUST pass the runtime tree-sitter.wasm
 *      bytes via `wasmBinary`, since locateFile() can't resolve
 *      file paths in a Worker. In Node tests, the package's `main`
 *      auto-resolves the file path.
 *
 *   2. `Language.load(bytes)` accepts a Uint8Array directly (web-tree-sitter
 *      0.20.x API, confirmed via tree-sitter-web.d.ts:140). Languages are
 *      cached per (lang, sha8) so repeated parses skip the load step.
 *
 * Worker bootstrap TODO (slice 2 / handler integration): import
 * `web-tree-sitter/tree-sitter.wasm` via Wrangler's WASM bundling and pass
 * the bytes to bootstrapParser({ runtimeWasmBytes }). The handler-side
 * call is the only place that needs to know about the bundled binary.
 */

import Parser from 'web-tree-sitter';

import type { GrammarLanguage } from '../types';

// ---------------------------------------------------------------------------
// Init lifecycle
// ---------------------------------------------------------------------------

let initPromise: Promise<void> | null = null;

export interface BootstrapOptions {
  /**
   * Bytes of `web-tree-sitter/tree-sitter.wasm`. REQUIRED in Cloudflare
   * Workers (no file system); OPTIONAL in Node tests (auto-resolves).
   */
  runtimeWasmBytes?: ArrayBuffer | Uint8Array;
}

/**
 * Initialize the web-tree-sitter runtime. Idempotent — concurrent calls
 * share the single init promise.
 */
export async function bootstrapParser(opts: BootstrapOptions = {}): Promise<void> {
  if (initPromise) return initPromise;
  // Emscripten's module options accept `wasmBinary` (ArrayBuffer) to skip
  // its locateFile-based resolution. We forward whatever the caller gave us.
  const moduleOptions: Record<string, unknown> = {};
  if (opts.runtimeWasmBytes) {
    moduleOptions.wasmBinary = opts.runtimeWasmBytes;
  }
  initPromise = Parser.init(moduleOptions);
  return initPromise;
}

/** Test-only: clear the init promise + language cache between tests. */
export function _resetParserStateForTesting(): void {
  initPromise = null;
  languageCache.clear();
}

// ---------------------------------------------------------------------------
// Language cache
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const languageCache = new Map<string, any>(); // value is web-tree-sitter Language

/**
 * Load a tree-sitter Language from raw WASM bytes (as supplied by
 * GrammarLoader.loadGrammar().bytes). Cached per (language, sha8).
 */
export async function loadLanguage(
  language: GrammarLanguage,
  bytes: Uint8Array,
  sha256: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const key = `${language}@${sha256.slice(0, 8)}`;
  const hit = languageCache.get(key);
  if (hit) return hit;

  await bootstrapParser();
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
