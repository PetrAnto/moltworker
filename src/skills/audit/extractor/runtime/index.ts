/**
 * Bundled tree-sitter runtime WASM — cold-start fallback.
 *
 * The audit handler prefers an R2-stored runtime (hot-uploadable via
 * `npm run audit:upload-grammars`) so a new web-tree-sitter version can
 * be rolled out without a Worker redeploy. This bundled copy is the
 * fallback path: if R2 is missing the runtime entry, returns null on
 * fetch, or fails the SHA check, the handler uses these bytes instead
 * so /audit --analyze never has a hard dependency on R2 being warm.
 *
 * The source-of-truth `.wasm` lives in `node_modules/web-tree-sitter`;
 * `npm run audit:sync-runtime` regenerates the .generated.ts file
 * (base64 string + SHA-256 + size + version tag). The generated file
 * is committed so deploys don't need to run the sync first.
 */

import { MAX_TREE_SITTER_RUNTIME_BYTES } from '../../types';
import {
  RUNTIME_WASM_BASE64,
  RUNTIME_WASM_SHA256,
  RUNTIME_WASM_SIZE,
  RUNTIME_WASM_SOURCE,
} from './runtime-wasm.generated';

export interface BundledRuntime {
  bytes: Uint8Array;
  sha256: string;
  size: number;
  /** e.g. "web-tree-sitter@0.20.8" — surfaced in telemetry. */
  source: string;
}

let cached: BundledRuntime | null | undefined;

/**
 * Decode the base64 payload into bytes. Returns null if the bytes are
 * absent (placeholder file or sync hasn't been run) or fail SHA / size
 * sanity checks. Result is memoized per isolate so subsequent calls are
 * a Map lookup.
 *
 * Tests use _resetBundledRuntimeCacheForTesting() to undo memoization.
 */
export async function getBundledRuntimeWasm(): Promise<BundledRuntime | null> {
  if (cached !== undefined) return cached;
  if (!RUNTIME_WASM_BASE64 || RUNTIME_WASM_BASE64.length === 0) {
    console.warn('[Audit] bundled runtime WASM is empty — run `npm run audit:sync-runtime`');
    cached = null;
    return cached;
  }

  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(RUNTIME_WASM_BASE64);
  } catch (err) {
    console.error('[Audit] bundled runtime WASM failed to decode:', err instanceof Error ? err.message : err);
    cached = null;
    return cached;
  }

  if (bytes.byteLength !== RUNTIME_WASM_SIZE) {
    console.warn(`[Audit] bundled runtime size mismatch: declared ${RUNTIME_WASM_SIZE}, decoded ${bytes.byteLength}`);
    cached = null;
    return cached;
  }
  if (bytes.byteLength > MAX_TREE_SITTER_RUNTIME_BYTES) {
    console.warn(`[Audit] bundled runtime size ${bytes.byteLength} exceeds MAX_TREE_SITTER_RUNTIME_BYTES`);
    cached = null;
    return cached;
  }

  // Integrity check: regenerate the SHA on every cold start. The npm
  // package + the SHA + the base64 are all generated together; a
  // mismatch means someone hand-edited the generated file. Fail loud
  // — the bundled fallback's whole reason to exist is determinism.
  const actualSha = await sha256Hex(bytes);
  if (actualSha !== RUNTIME_WASM_SHA256) {
    console.error(`[Audit] bundled runtime SHA mismatch: generated ${RUNTIME_WASM_SHA256}, computed ${actualSha}. Refusing to use.`);
    cached = null;
    return cached;
  }

  cached = { bytes, sha256: RUNTIME_WASM_SHA256, size: bytes.byteLength, source: RUNTIME_WASM_SOURCE };
  return cached;
}

/** Test-only: clear the per-isolate memoization. */
export function _resetBundledRuntimeCacheForTesting(): void {
  cached = undefined;
}

// ---------------------------------------------------------------------------
// Helpers — kept inline to avoid a dependency on Buffer (Workers don't
// have Node's Buffer in the Edge runtime by default; atob does work).
// ---------------------------------------------------------------------------

function base64ToBytes(b64: string): Uint8Array {
  // atob is available in Workers and Node ≥ 16.
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Extract a tight ArrayBuffer view — TS strict mode rejects passing the
  // Uint8Array directly because its underlying buffer type is ArrayBufferLike
  // (could be SharedArrayBuffer) while crypto.subtle.digest wants ArrayBuffer.
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const view = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < view.length; i++) out += view[i].toString(16).padStart(2, '0');
  return out;
}
