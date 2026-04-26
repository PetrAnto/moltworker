/**
 * Audit Skill — Extractor tests
 *
 * Two-tier coverage:
 *
 *   1. Logic + dispatch tests (always run): use a fake grammar/parser to
 *      exercise the Extractor's path-enum guard, manifest emission,
 *      workflow handling, error paths, and language dispatch.
 *
 *   2. Real-grammar smoke (gated): if `tree-sitter-wasms` is installed
 *      (devDep), parse a small TS source against the actual TypeScript
 *      grammar and assert function/class/import nodes are recognized.
 *      This is the canary that catches upstream node-type renames.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { extractSnippets } from './extractor';
import { _resetParserStateForTesting } from './parser';
import { classifyNode, relevantNodeTypes } from './queries';
import type { GrammarLanguage, RepoProfile, ManifestFile } from '../types';
import type { LoadResult } from '../grammars/loader';

// ---------------------------------------------------------------------------
// Common fixtures
// ---------------------------------------------------------------------------

function profileFor(paths: string[], manifests: ManifestFile[] = []): RepoProfile {
  return {
    owner: 'octocat', repo: 'demo', defaultBranch: 'main', sha: 'a'.repeat(40),
    meta: { private: false, archived: false, sizeKb: 0, primaryLanguage: 'TypeScript', languages: {}, description: null },
    tree: paths.map((p, i) => ({ path: p, type: 'blob' as const, sha: `s${i}`, size: 100 })),
    manifests,
    codeScanningAlerts: [],
    codeScanningAlertsTruncated: false,
    treeTruncated: false,
    profileHash: 'h',
    collectedAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  _resetParserStateForTesting();
});

// ---------------------------------------------------------------------------
// Logic tests — no real grammar needed
// ---------------------------------------------------------------------------

describe('extractSnippets — logic', () => {
  it('emits manifests verbatim before any parse work', async () => {
    const profile = profileFor(['package.json'], [
      { path: 'package.json', sha: 'm', content: '{"name":"x"}' },
    ]);
    const result = await extractSnippets({
      profile,
      selections: [],
      loadGrammar: () => Promise.resolve(null),
    });
    expect(result.snippets).toHaveLength(1);
    expect(result.snippets[0].kind).toBe('manifest');
    expect(result.snippets[0].text).toBe('{"name":"x"}');
    expect(result.snippets[0].language).toBe('json');
    expect(result.byKind.manifest).toBe(1);
    expect(result.languagesUsed.has('json')).toBe(true);
  });

  it('skips manifest entries with content === null (too-large or fetch-failed)', async () => {
    const profile = profileFor([], [
      { path: 'package.json', sha: 'm', content: null },
    ]);
    const result = await extractSnippets({
      profile, selections: [], loadGrammar: () => Promise.resolve(null),
    });
    expect(result.snippets).toHaveLength(0);
  });

  it('rejects selections whose path is not in profile.tree (anti-hallucination guard)', async () => {
    const profile = profileFor(['src/known.ts']);
    const result = await extractSnippets({
      profile,
      selections: [
        { path: 'src/known.ts', content: 'function ok() {}' },
        { path: 'src/forged.ts', content: 'function bad() {}' }, // not in tree
      ],
      loadGrammar: () => Promise.resolve(null), // will fail loadGrammar
    });
    // forged.ts -> rejected before grammar load; known.ts -> grammar unavailable
    const reasons = result.parseErrors.map(e => `${e.path}: ${e.reason}`);
    expect(reasons.some(r => r.includes('forged.ts') && r.includes('rejected'))).toBe(true);
  });

  it('emits workflow yml as a single full-file snippet', async () => {
    const wf = `name: deploy
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3`;
    const profile = profileFor(['.github/workflows/deploy.yml']);
    const result = await extractSnippets({
      profile,
      selections: [{ path: '.github/workflows/deploy.yml', content: wf }],
      loadGrammar: () => Promise.resolve(null),
    });
    expect(result.snippets).toHaveLength(1);
    expect(result.snippets[0].kind).toBe('workflow');
    expect(result.snippets[0].language).toBe('yaml');
    expect(result.snippets[0].text).toBe(wf);
    expect(result.byKind.workflow).toBe(1);
  });

  it('records parseErrors when a grammar is unavailable', async () => {
    const profile = profileFor(['src/x.ts']);
    const result = await extractSnippets({
      profile,
      selections: [{ path: 'src/x.ts', content: 'const a = 1;' }],
      loadGrammar: () => Promise.resolve(null), // simulate "grammars not uploaded"
    });
    expect(result.snippets).toHaveLength(0);
    expect(result.parseErrors.length).toBe(1);
    expect(result.parseErrors[0].reason).toContain('grammar "typescript" unavailable');
  });

  it('reports unsupported file extensions as parseErrors, not crashes', async () => {
    const profile = profileFor(['src/foo.cpp']);
    const result = await extractSnippets({
      profile,
      selections: [{ path: 'src/foo.cpp', content: 'int main() {}' }],
      loadGrammar: () => Promise.resolve(null),
    });
    expect(result.parseErrors[0].reason).toContain('no grammar for this file extension');
  });

  it('truncates oversized snippets and sets the truncated flag', async () => {
    // 10 KiB of content — exceeds MAX_SNIPPET_BYTES=8 KiB for the manifest path
    const big = 'x'.repeat(10000);
    const profile = profileFor([], [
      { path: 'README.md', sha: 'm', content: big },
    ]);
    const result = await extractSnippets({
      profile, selections: [], loadGrammar: () => Promise.resolve(null),
    });
    expect(result.snippets[0].truncated).toBe(true);
    expect(result.snippets[0].text.length).toBeLessThan(big.length);
    expect(result.snippets[0].text).toContain('[truncated]');
  });
});

// ---------------------------------------------------------------------------
// queries.ts — node-type maps
// ---------------------------------------------------------------------------

describe('classifyNode', () => {
  it('classifies TypeScript function/class/import/export', () => {
    expect(classifyNode('typescript', 'function_declaration')).toBe('function');
    expect(classifyNode('typescript', 'class_declaration')).toBe('class');
    expect(classifyNode('typescript', 'interface_declaration')).toBe('class');
    expect(classifyNode('typescript', 'type_alias_declaration')).toBe('class');
    expect(classifyNode('typescript', 'import_statement')).toBe('import');
    expect(classifyNode('typescript', 'export_statement')).toBe('export');
    expect(classifyNode('typescript', 'comment')).toBeNull();
  });

  it('classifies Python with no exports', () => {
    expect(classifyNode('python', 'function_definition')).toBe('function');
    expect(classifyNode('python', 'class_definition')).toBe('class');
    expect(classifyNode('python', 'import_from_statement')).toBe('import');
    expect(classifyNode('python', 'export_statement')).toBeNull();
  });

  it('relevantNodeTypes is non-empty for every MVP language', () => {
    for (const lang of ['typescript', 'tsx', 'javascript', 'python', 'go'] as GrammarLanguage[]) {
      expect(relevantNodeTypes(lang).length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Real-grammar smoke — gated on tree-sitter-wasms being installed
// ---------------------------------------------------------------------------

const TS_GRAMMAR_PATH = resolve('node_modules/tree-sitter-wasms/out/tree-sitter-typescript.wasm');
const HAS_REAL_GRAMMAR = existsSync(TS_GRAMMAR_PATH);

const realGrammarTest = HAS_REAL_GRAMMAR ? describe : describe.skip;

realGrammarTest('extractSnippets — real tree-sitter-typescript grammar', () => {
  async function realLoader(lang: GrammarLanguage): Promise<LoadResult | null> {
    if (lang !== 'typescript') return null;
    const bytes = await readFile(TS_GRAMMAR_PATH);
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    // For tests we don't need the manifest pipeline; fabricate the entry shape.
    return {
      bytes: new Uint8Array(buf),
      module: await WebAssembly.compile(buf),
      entry: {
        language: 'typescript',
        key: 'audit/grammars/typescript@deadbeef.wasm',
        sha256: 'd'.repeat(64),
        size: buf.byteLength,
        source: 'tree-sitter-wasms@0.1.13',
        uploadedAt: '2026-04-26T00:00:00.000Z',
      },
      cached: false,
    };
  }

  it('extracts function + class + import nodes from a small TS source', async () => {
    const src = `import { foo } from './foo';
import bar from './bar';

export function hello(name: string): string {
  return \`hi \${name}\`;
}

export class Greeter {
  greet(person: string) {
    return hello(person);
  }
}

export interface Config { url: string }
export type Handler = (req: Request) => Response;
`;
    const profile = profileFor(['src/demo.ts']);
    const result = await extractSnippets({
      profile,
      selections: [{ path: 'src/demo.ts', content: src }],
      loadGrammar: realLoader,
    });

    expect(result.parseErrors).toEqual([]);
    expect(result.languagesUsed.has('typescript')).toBe(true);

    const kinds = result.snippets.map(s => s.kind);
    expect(kinds).toContain('function');
    expect(kinds).toContain('class');
    expect(kinds).toContain('import');

    const fn = result.snippets.find(s => s.kind === 'function');
    expect(fn?.name).toBe('hello');
    expect(fn?.text).toContain('hi ${name}');

    const cls = result.snippets.find(s => s.kind === 'class' && s.name === 'Greeter');
    expect(cls).toBeDefined();
    expect(cls?.text).toContain('greet');

    const iface = result.snippets.find(s => s.kind === 'class' && s.name === 'Config');
    expect(iface).toBeDefined();

    const imports = result.snippets.filter(s => s.kind === 'import');
    expect(imports.length).toBeGreaterThanOrEqual(2);
  });

  it('continues past parse errors instead of throwing', async () => {
    const profile = profileFor(['src/good.ts', 'src/bad.ts']);
    const result = await extractSnippets({
      profile,
      selections: [
        { path: 'src/good.ts', content: 'export function ok() {}' },
        // tree-sitter is forgiving — even malformed input parses to a tree
        // with ERROR nodes. So this still produces snippets, no crash.
        { path: 'src/bad.ts', content: 'export function ok( {' },
      ],
      loadGrammar: realLoader,
    });

    expect(result.parseErrors).toEqual([]); // tree-sitter never throws
    expect(result.snippets.length).toBeGreaterThan(0);
  });

  it('records line ranges and truncation for huge functions', async () => {
    // Build a function whose body exceeds MAX_SNIPPET_BYTES (8 KiB).
    const bigBody = '  console.log("x");\n'.repeat(500); // ~10 KiB
    const src = `export function big() {\n${bigBody}}\n`;
    const profile = profileFor(['src/big.ts']);
    const result = await extractSnippets({
      profile,
      selections: [{ path: 'src/big.ts', content: src }],
      loadGrammar: realLoader,
    });

    const fn = result.snippets.find(s => s.kind === 'function' && s.name === 'big');
    expect(fn).toBeDefined();
    expect(fn?.truncated).toBe(true);
    expect(fn?.startLine).toBe(1);
    expect(fn?.endLine).toBeGreaterThan(500);
    expect(fn?.text).toContain('[truncated]');
  });
});

// ---------------------------------------------------------------------------
// Skip-banner so users know if the gated suite is actually running
// ---------------------------------------------------------------------------

if (!HAS_REAL_GRAMMAR) {
  describe('extractor real-grammar smoke', () => {
    it('skipped: install tree-sitter-wasms (devDep) to run', () => {
      expect(HAS_REAL_GRAMMAR).toBe(false);
    });
  });
}
