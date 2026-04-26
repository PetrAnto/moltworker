/**
 * Worker-bootstrap integration test — closes the loop on slice 1b's plumbing fix.
 *
 * GPT's review of slice 1b correctly noted that just typing `parserBootstrap`
 * on `ExtractContext` doesn't prove the bytes actually reach `Parser.init`.
 * This file globally mocks `web-tree-sitter` and asserts the byte-forwarding
 * end-to-end: extractSnippets({parserBootstrap: {runtimeWasmBytes}})
 *   -> loadLanguage(..., {runtimeWasmBytes})
 *     -> bootstrapParser({runtimeWasmBytes})
 *       -> Parser.init({wasmBinary: <those exact bytes>})
 *
 * The mock is at module scope (not per-test) because vi.mock is hoisted —
 * which is why this lives in a separate file from extractor.test.ts (whose
 * gated real-grammar tier needs the real package).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock web-tree-sitter — capture every Parser.init call
// ---------------------------------------------------------------------------

const initCalls: Array<Record<string, unknown>> = [];

vi.mock('web-tree-sitter', () => {
  // Minimal shape of the bits parser.ts touches: Parser.init (static),
  // Parser.Language.load (static), parser instance with setLanguage + parse.
  const fakeNode = {
    type: 'function_declaration',
    startPosition: { row: 0, column: 0 },
    endPosition: { row: 0, column: 11 },
    startIndex: 0, endIndex: 11,
    namedChildCount: 0,
    childForFieldName: () => ({ text: 'demo' }),
    namedChild: () => null,
  };
  const fakeTree = {
    rootNode: { descendantsOfType: () => [fakeNode] },
    delete: vi.fn(),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Parser: any = function() {
    return {
      setLanguage: () => {},
      parse: () => fakeTree,
    };
  };
  Parser.init = vi.fn(async (opts: Record<string, unknown> = {}) => {
    initCalls.push(opts);
  });
  Parser.Language = {
    load: vi.fn(async (_bytes: Uint8Array) => ({ /* opaque language token */ })),
  };
  return { default: Parser };
});

// ---------------------------------------------------------------------------
// Imports — must come after vi.mock so the mocked module is wired in
// ---------------------------------------------------------------------------

import { extractSnippets } from './extractor';
import { _resetParserStateForTesting, _initModeForTesting } from './parser';
import type { LoadResult } from '../grammars/loader';
import type { GrammarLanguage, RepoProfile } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function profileFor(paths: string[]): RepoProfile {
  return {
    owner: 'octocat', repo: 'demo', defaultBranch: 'main', sha: 'a'.repeat(40),
    meta: { private: false, archived: false, sizeKb: 0, primaryLanguage: 'TypeScript', languages: {}, description: null },
    tree: paths.map((p, i) => ({ path: p, type: 'blob' as const, sha: `s${i}`, size: 100 })),
    manifests: [],
    codeScanningAlerts: [],
    codeScanningAlertsTruncated: false,
    treeTruncated: false,
    profileHash: 'h',
    collectedAt: new Date().toISOString(),
  };
}

const MIN_WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

function fakeGrammar(language: GrammarLanguage, bytes: Uint8Array = MIN_WASM): LoadResult {
  return {
    bytes,
    // Note: WebAssembly.compile is not called here — we don't need a real
    // module for the byte-forwarding test (Parser.init is fully mocked).
    module: undefined as unknown as WebAssembly.Module,
    entry: {
      language,
      key: `audit/grammars/${language}@cafebabe.wasm`,
      sha256: 'c'.repeat(64),
      size: bytes.length,
      source: 'test',
      uploadedAt: '2026-04-26T00:00:00.000Z',
    },
    cached: false,
  };
}

beforeEach(() => {
  _resetParserStateForTesting();
  initCalls.length = 0;
});

// ---------------------------------------------------------------------------
// The integration assertion
// ---------------------------------------------------------------------------

describe('Worker bootstrap byte-forwarding (integration)', () => {
  it('passes runtimeWasmBytes from ExtractContext all the way to Parser.init({wasmBinary})', async () => {
    // Use a recognisable byte pattern so we can assert identity, not just
    // "an array exists".
    const runtimeBytes = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x61, 0x73, 0x6d]);

    const result = await extractSnippets({
      profile: profileFor(['src/x.ts']),
      selections: [{ path: 'src/x.ts', content: 'function demo(){}' }],
      loadGrammar: async () => fakeGrammar('typescript'),
      parserBootstrap: { runtimeWasmBytes: runtimeBytes },
    });

    // Parser.init was called exactly once (idempotent across the run)
    expect(initCalls.length).toBe(1);
    // The bytes we passed in via parserBootstrap.runtimeWasmBytes
    // landed verbatim as init({wasmBinary: ...}).
    expect(initCalls[0]).toHaveProperty('wasmBinary');
    expect(initCalls[0].wasmBinary).toBe(runtimeBytes);

    // Sanity: the rest of the pipeline kept working — we got at least one
    // snippet from the (mocked) tree walk.
    expect(result.parseErrors).toEqual([]);
    expect(result.snippets.length).toBeGreaterThan(0);
    expect(_initModeForTesting()).toBe('wasmBinary');
  });

  it('omits wasmBinary when no parserBootstrap is supplied (Node-auto mode)', async () => {
    await extractSnippets({
      profile: profileFor(['src/x.ts']),
      selections: [{ path: 'src/x.ts', content: 'function demo(){}' }],
      loadGrammar: async () => fakeGrammar('typescript'),
      // no parserBootstrap
    });

    expect(initCalls.length).toBe(1);
    expect(initCalls[0]).not.toHaveProperty('wasmBinary');
    expect(_initModeForTesting()).toBe('node-auto');
  });

  it('Parser.init is called once even when multiple files are extracted', async () => {
    const runtimeBytes = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
    await extractSnippets({
      profile: profileFor(['src/a.ts', 'src/b.ts', 'src/c.ts']),
      selections: [
        { path: 'src/a.ts', content: 'function a(){}' },
        { path: 'src/b.ts', content: 'function b(){}' },
        { path: 'src/c.ts', content: 'function c(){}' },
      ],
      loadGrammar: async () => fakeGrammar('typescript'),
      parserBootstrap: { runtimeWasmBytes: runtimeBytes },
    });
    // Critical efficiency property: bootstrap is per-isolate, not per-file.
    expect(initCalls.length).toBe(1);
  });
});
