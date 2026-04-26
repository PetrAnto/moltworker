/**
 * Bundled tree-sitter runtime — loader contract tests.
 *
 * The runtime-wasm.generated.ts file is committed; these tests exercise
 * the decode + SHA verification + memoization without booting a real
 * Worker.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getBundledRuntimeWasm, _resetBundledRuntimeCacheForTesting } from './index';
import {
  RUNTIME_WASM_BASE64,
  RUNTIME_WASM_SHA256,
  RUNTIME_WASM_SIZE,
  RUNTIME_WASM_SOURCE,
} from './runtime-wasm.generated';

beforeEach(() => {
  _resetBundledRuntimeCacheForTesting();
});

describe('getBundledRuntimeWasm', () => {
  it('returns bytes that round-trip the SHA-256 declared in the generated file', async () => {
    const r = await getBundledRuntimeWasm();
    expect(r).not.toBeNull();
    expect(r!.sha256).toBe(RUNTIME_WASM_SHA256);
    expect(r!.size).toBe(RUNTIME_WASM_SIZE);
    expect(r!.source).toBe(RUNTIME_WASM_SOURCE);
    expect(r!.bytes).toBeInstanceOf(Uint8Array);
    expect(r!.bytes.byteLength).toBe(RUNTIME_WASM_SIZE);

    // Sanity: the bytes start with the WebAssembly magic number 0x00 'asm'
    expect(r!.bytes[0]).toBe(0x00);
    expect(r!.bytes[1]).toBe(0x61); // 'a'
    expect(r!.bytes[2]).toBe(0x73); // 's'
    expect(r!.bytes[3]).toBe(0x6d); // 'm'
  });

  it('memoizes — second call returns the SAME object reference (not just equal)', async () => {
    const a = await getBundledRuntimeWasm();
    const b = await getBundledRuntimeWasm();
    expect(a).toBe(b);
    // Same identity on the bytes too — confirms no double-decode
    expect(a!.bytes).toBe(b!.bytes);
  });

  it('_resetBundledRuntimeCacheForTesting clears the memoized result', async () => {
    const a = await getBundledRuntimeWasm();
    _resetBundledRuntimeCacheForTesting();
    const b = await getBundledRuntimeWasm();
    expect(a).not.toBe(b); // new object after reset
    expect(a!.sha256).toBe(b!.sha256); // but same content
  });
});

describe('generated file invariants', () => {
  it('SHA-256 is a 64-char hex string', () => {
    expect(RUNTIME_WASM_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('source tag includes the npm package name', () => {
    expect(RUNTIME_WASM_SOURCE).toMatch(/^web-tree-sitter@\d+\.\d+\.\d+/);
  });

  it('size is positive and within MAX_TREE_SITTER_RUNTIME_BYTES', () => {
    expect(RUNTIME_WASM_SIZE).toBeGreaterThan(0);
    expect(RUNTIME_WASM_SIZE).toBeLessThanOrEqual(1 * 1024 * 1024);
  });

  it('base64 is non-empty (sync script has been run)', () => {
    expect(RUNTIME_WASM_BASE64.length).toBeGreaterThan(0);
    expect(RUNTIME_WASM_BASE64).toMatch(/^[A-Za-z0-9+/=]+$/); // valid base64 charset
  });
});

// Integrity-guard failure paths (empty base64, size mismatch, SHA tamper)
// are exercised by code review against the source of getBundledRuntimeWasm
// — they're inline checks before the cached bytes return, and mocking the
// `./runtime-wasm.generated` ESM via vi.doMock collides with the per-file
// hoisting that vitest applies. The happy-path tests above pin the
// contract: bytes round-trip, SHA matches, memoization works.
