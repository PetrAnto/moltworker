import { describe, it, expect, vi } from 'vitest';
import {
  isExtractionTask,
  detectExtractionDetails,
  verifyExtraction,
  formatVerificationForContext,
  scanCrossFileReferences,
  checkBracketBalance,
  computeRelativeImportPath,
  type ExtractionCheck,
  type ExtractionVerification,
} from './extraction-verifier';
import type { ChatMessage } from '../openrouter/client';

// ─── Helpers ────────────────────────────────────────────────────────────────

function assistantWithTools(
  content: string | null,
  toolCalls: Array<{ id: string; name: string; args: string }>,
): ChatMessage {
  return {
    role: 'assistant',
    content,
    tool_calls: toolCalls.map(tc => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.name, arguments: tc.args },
    })),
  };
}

function toolResult(callId: string, content: string): ChatMessage {
  return { role: 'tool', content, tool_call_id: callId };
}

// ─── isExtractionTask ───────────────────────────────────────────────────────

describe('isExtractionTask', () => {
  it('returns true when workspace_write_file + github_create_pr used', () => {
    expect(isExtractionTask([
      'github_read_file', 'workspace_write_file', 'workspace_commit', 'github_create_pr',
    ])).toBe(true);
  });

  it('returns true when github_push_files used for both create and patch', () => {
    expect(isExtractionTask([
      'github_read_file', 'github_push_files', 'github_create_pr',
    ])).toBe(true);
  });

  it('returns false when only reading files', () => {
    expect(isExtractionTask(['github_read_file', 'github_list_files'])).toBe(false);
  });

  it('returns false when only creating PR without file creation', () => {
    expect(isExtractionTask(['github_read_file', 'github_create_pr'])).toBe(false);
  });

  it('returns false for empty tools', () => {
    expect(isExtractionTask([])).toBe(false);
  });

  // --- Precise detection with messages ---

  it('returns true with messages when push has both create and patch actions', () => {
    const messages: ChatMessage[] = [
      assistantWithTools(null, [{ id: 'tc1', name: 'github_push_files', args: JSON.stringify({
        changes: JSON.stringify([
          { path: 'src/utils.js', action: 'create', content: 'export function clamp() {}' },
          { path: 'src/App.jsx', action: 'patch', patches: [{ find: 'function clamp', replace: '' }] },
        ]),
      }) }]),
    ];
    expect(isExtractionTask(['github_push_files'], messages)).toBe(true);
  });

  it('returns false with messages when push only has create actions (feature-add, not extraction)', () => {
    const messages: ChatMessage[] = [
      assistantWithTools(null, [{ id: 'tc1', name: 'github_push_files', args: JSON.stringify({
        changes: JSON.stringify([
          { path: 'src/collapsible.jsx', action: 'create', content: 'export function Collapsible() {}' },
          { path: 'ROADMAP.md', action: 'create', content: '- [x] Done' },
        ]),
      }) }]),
      assistantWithTools(null, [{ id: 'tc2', name: 'github_create_pr', args: JSON.stringify({
        title: 'Add collapsible sections',
        changes: JSON.stringify([
          { path: 'src/components/Section.jsx', action: 'create', content: 'updated component' },
        ]),
      }) }]),
    ];
    expect(isExtractionTask(['github_push_files', 'github_create_pr'], messages)).toBe(false);
  });

  it('returns false with messages for update-only changes (no create)', () => {
    const messages: ChatMessage[] = [
      assistantWithTools(null, [{ id: 'tc1', name: 'github_push_files', args: JSON.stringify({
        changes: JSON.stringify([
          { path: 'src/App.jsx', action: 'update', content: 'modified content' },
        ]),
      }) }]),
    ];
    expect(isExtractionTask(['github_push_files'], messages)).toBe(false);
  });
});

// ─── detectExtractionDetails ────────────────────────────────────────────────

describe('detectExtractionDetails', () => {
  it('detects workspace_write_file + github_create_pr with changes as JSON string', () => {
    const messages: ChatMessage[] = [
      assistantWithTools(null, [{
        id: 'tc1',
        name: 'workspace_write_file',
        args: JSON.stringify({ path: 'src/utils.js', content: 'export function clamp(v) { return v; }' }),
      }]),
      toolResult('tc1', 'File staged: src/utils.js'),
      assistantWithTools(null, [{
        id: 'tc2',
        name: 'github_create_pr',
        args: JSON.stringify({
          owner: 'user', repo: 'app', branch: 'refactor',
          // changes is a JSON STRING (matches real tool schema)
          changes: JSON.stringify([{
            path: 'src/App.jsx',
            action: 'patch',
            patches: [
              { find: 'function clamp(v) { return v; }', replace: "import { clamp } from './utils'" },
            ],
          }]),
        }),
      }]),
      toolResult('tc2', 'PR created'),
    ];

    const result = detectExtractionDetails(messages);
    expect(result).not.toBeNull();
    expect(result!.sourceFile).toBe('src/App.jsx');
    expect(result!.newFiles).toContain('src/utils.js');
    expect(result!.extractedNames).toContain('clamp');
  });

  it('also handles changes as direct array (some models pass it this way)', () => {
    const messages: ChatMessage[] = [
      assistantWithTools(null, [{
        id: 'tc1',
        name: 'workspace_write_file',
        args: JSON.stringify({ path: 'src/utils.js', content: 'export function clamp(v) { return v; }' }),
      }]),
      toolResult('tc1', 'File staged'),
      assistantWithTools(null, [{
        id: 'tc2',
        name: 'github_create_pr',
        args: JSON.stringify({
          owner: 'user', repo: 'app', branch: 'refactor',
          // changes as direct array (legacy/alternative format)
          changes: [{
            path: 'src/App.jsx',
            action: 'patch',
            patches: [{ find: 'function clamp(v) {}', replace: "import { clamp } from './utils'" }],
          }],
        }),
      }]),
      toolResult('tc2', 'PR created'),
    ];

    const result = detectExtractionDetails(messages);
    expect(result).not.toBeNull();
    expect(result!.sourceFile).toBe('src/App.jsx');
  });

  it('tracks initial source file line count from github_read_file', () => {
    const sourceContent = 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10';
    const messages: ChatMessage[] = [
      assistantWithTools(null, [{
        id: 'read1',
        name: 'github_read_file',
        args: JSON.stringify({ owner: 'user', repo: 'app', path: 'src/App.jsx' }),
      }]),
      toolResult('read1', sourceContent),
      assistantWithTools(null, [{
        id: 'tc1',
        name: 'workspace_write_file',
        args: JSON.stringify({ path: 'src/utils.js', content: 'export const x = 1;\nexport const y = 2;\nexport const z = 3;' }),
      }]),
      toolResult('tc1', 'File staged'),
      assistantWithTools(null, [{
        id: 'tc2',
        name: 'github_create_pr',
        args: JSON.stringify({
          owner: 'user', repo: 'app', branch: 'refactor',
          changes: JSON.stringify([
            { path: 'src/App.jsx', action: 'patch', patches: [{ find: 'old', replace: 'new' }] },
          ]),
        }),
      }]),
      toolResult('tc2', 'PR created'),
    ];

    const result = detectExtractionDetails(messages);
    expect(result).not.toBeNull();
    expect(result!.sourceInitialLineCount).toBe(10);
    expect(result!.newFileLineCount).toBe(3);
  });

  it('filters out ROADMAP.md and WORK_LOG.md from source files', () => {
    const messages: ChatMessage[] = [
      assistantWithTools(null, [{
        id: 'tc1',
        name: 'workspace_write_file',
        args: JSON.stringify({ path: 'src/helpers.js', content: 'export const fmt = () => {}' }),
      }]),
      toolResult('tc1', 'Staged'),
      assistantWithTools(null, [{
        id: 'tc2',
        name: 'github_create_pr',
        args: JSON.stringify({
          owner: 'user', repo: 'app', branch: 'split',
          changes: JSON.stringify([
            { path: 'src/App.jsx', action: 'patch', patches: [{ find: 'const fmt = () => {}', replace: "import { fmt } from './helpers'" }] },
            { path: 'ROADMAP.md', action: 'patch', patches: [{ find: '- [ ]', replace: '- [x]' }] },
            { path: 'WORK_LOG.md', action: 'patch', patches: [{ find: '| ---', replace: '| --- |' }] },
          ]),
        }),
      }]),
      toolResult('tc2', 'PR created'),
    ];

    const result = detectExtractionDetails(messages);
    expect(result).not.toBeNull();
    expect(result!.sourceFile).toBe('src/App.jsx');
  });

  it('returns null when no files are created', () => {
    const messages: ChatMessage[] = [
      assistantWithTools(null, [{
        id: 'tc1',
        name: 'github_create_pr',
        args: JSON.stringify({
          owner: 'user', repo: 'app', branch: 'fix',
          changes: JSON.stringify([{ path: 'src/App.jsx', action: 'patch', patches: [{ find: 'old', replace: 'new' }] }]),
        }),
      }]),
      toolResult('tc1', 'PR created'),
    ];

    expect(detectExtractionDetails(messages)).toBeNull();
  });

  it('returns null when no source files are patched', () => {
    const messages: ChatMessage[] = [
      assistantWithTools(null, [{
        id: 'tc1',
        name: 'workspace_write_file',
        args: JSON.stringify({ path: 'src/new-module.js', content: 'export default {}' }),
      }]),
      toolResult('tc1', 'Staged'),
    ];

    expect(detectExtractionDetails(messages)).toBeNull();
  });
});

// ─── verifyExtraction ───────────────────────────────────────────────────────

describe('verifyExtraction', () => {
  const baseExtraction: ExtractionCheck = {
    sourceFile: 'src/App.jsx',
    newFiles: ['src/utils.js'],
    extractedNames: ['clamp', 'fmt'],
    sourceInitialLineCount: null,
    newFileLineCount: null,
  };

  it('passes when extraction is correct — identifiers removed from source, present in new file', async () => {
    const readFile = vi.fn(async (path: string) => {
      if (path === 'src/App.jsx') {
        return "import { clamp, fmt } from './utils';\n\nfunction App() { return <div>{clamp(1)}</div>; }";
      }
      if (path === 'src/utils.js') {
        return 'export function clamp(v) { return v; }\nexport const fmt = (x) => x.toFixed(2);';
      }
      return null;
    });

    const result = await verifyExtraction(baseExtraction, readFile);
    expect(result.passed).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('fails when extracted identifiers are still declared in source', async () => {
    const readFile = vi.fn(async (path: string) => {
      if (path === 'src/App.jsx') {
        return "import { clamp } from './utils';\nfunction clamp(v) { return v; }\nconst fmt = (x) => x;";
      }
      if (path === 'src/utils.js') {
        return 'export function clamp(v) { return v; }\nexport const fmt = (x) => x;';
      }
      return null;
    });

    const result = await verifyExtraction(baseExtraction, readFile);
    expect(result.passed).toBe(false);
    expect(result.issues.some(i => i.includes('INCOMPLETE EXTRACTION'))).toBe(true);
    expect(result.issues.some(i => i.includes('clamp'))).toBe(true);
  });

  it('fails when source file does not import from new module', async () => {
    const readFile = vi.fn(async (path: string) => {
      if (path === 'src/App.jsx') {
        return 'function App() { return <div>Hello</div>; }';
      }
      if (path === 'src/utils.js') {
        return 'export function clamp(v) { return v; }';
      }
      return null;
    });

    const result = await verifyExtraction(baseExtraction, readFile);
    expect(result.passed).toBe(false);
    expect(result.issues.some(i => i.includes('does not appear to import'))).toBe(true);
  });

  it('fails when new module file is missing from branch', async () => {
    const readFile = vi.fn(async (path: string) => {
      if (path === 'src/App.jsx') {
        return "import { clamp } from './utils';\nfunction App() { return <div/>; }";
      }
      return null; // utils.js not found
    });

    const result = await verifyExtraction(baseExtraction, readFile);
    expect(result.passed).toBe(false);
    expect(result.issues.some(i => i.includes('not found on branch'))).toBe(true);
  });

  it('fails when source file is not readable', async () => {
    const readFile = vi.fn(async () => null);

    const result = await verifyExtraction(baseExtraction, readFile);
    expect(result.passed).toBe(false);
    expect(result.issues.some(i => i.includes('Could not read source file'))).toBe(true);
  });

  it('handles extraction with no named identifiers (still checks imports)', async () => {
    const extraction: ExtractionCheck = {
      sourceFile: 'src/App.jsx',
      newFiles: ['src/data.js'],
      extractedNames: [],
      sourceInitialLineCount: null,
      newFileLineCount: null,
    };

    const readFile = vi.fn(async (path: string) => {
      if (path === 'src/App.jsx') return "import { DESTS } from './data';\nfunction App() {}";
      if (path === 'src/data.js') return 'export const DESTS = [];';
      return null;
    });

    const result = await verifyExtraction(extraction, readFile);
    expect(result.passed).toBe(true);
  });

  it('fails when source file barely shrank (line count delta check)', async () => {
    // Source was 1000 lines, new file has 200 lines, but source only dropped to 990
    const extraction: ExtractionCheck = {
      sourceFile: 'src/App.jsx',
      newFiles: ['src/destinations.js'],
      extractedNames: ['INITIAL_DESTS'],
      sourceInitialLineCount: 1000,
      newFileLineCount: 200,
    };

    // Post-edit source still has 990 lines (only lost 10 lines instead of ~200)
    const longSource = Array.from({ length: 990 }, (_, i) =>
      i === 0 ? "import { INITIAL_DESTS } from './destinations'" : `  line ${i + 1}`,
    ).join('\n');

    const readFile = vi.fn(async (path: string) => {
      if (path === 'src/App.jsx') return longSource;
      if (path === 'src/destinations.js') return 'export const INITIAL_DESTS = [\n' + '  { id: "sofia" },\n'.repeat(198) + '];\n';
      return null;
    });

    const result = await verifyExtraction(extraction, readFile);
    expect(result.passed).toBe(false);
    expect(result.issues.some(i => i.includes('INSUFFICIENT LINE REDUCTION'))).toBe(true);
    expect(result.issues.some(i => i.includes('delta: 10'))).toBe(true);
  });

  it('passes line count check when source file shrank enough', async () => {
    const extraction: ExtractionCheck = {
      sourceFile: 'src/App.jsx',
      newFiles: ['src/destinations.js'],
      extractedNames: [],
      sourceInitialLineCount: 1000,
      newFileLineCount: 200,
    };

    // Post-edit source has 810 lines (lost 190, which is >50% of 200)
    const source = Array.from({ length: 810 }, (_, i) =>
      i === 0 ? "import { INITIAL_DESTS } from './destinations'" : `  line ${i + 1}`,
    ).join('\n');

    const readFile = vi.fn(async (path: string) => {
      if (path === 'src/App.jsx') return source;
      if (path === 'src/destinations.js') return 'export const INITIAL_DESTS = [];\n'.repeat(200);
      return null;
    });

    const result = await verifyExtraction(extraction, readFile);
    expect(result.passed).toBe(true);
  });

  it('skips line count check when no initial count is available', async () => {
    // sourceInitialLineCount is null, so the check should be skipped
    const readFile = vi.fn(async (path: string) => {
      if (path === 'src/App.jsx') {
        return "import { clamp, fmt } from './utils';\n\nfunction App() { return <div>{clamp(1)}</div>; }";
      }
      if (path === 'src/utils.js') {
        return 'export function clamp(v) { return v; }\nexport const fmt = (x) => x.toFixed(2);';
      }
      return null;
    });

    const result = await verifyExtraction(baseExtraction, readFile);
    expect(result.passed).toBe(true);
  });
});

// ─── checkBracketBalance ────────────────────────────────────────────────────

describe('checkBracketBalance', () => {
  it('returns null for balanced code', () => {
    expect(checkBracketBalance('function foo() { return [1, 2, 3]; }')).toBeNull();
  });

  it('returns null for balanced code with strings and comments', () => {
    const code = `
      // This has a { in a comment
      const x = "{ not a real bracket }";
      const y = \`template \${a + b}\`;
      /* multi-line { comment */
      function foo() { return [1]; }
    `;
    expect(checkBracketBalance(code)).toBeNull();
  });

  it('detects unclosed bracket (PR #79 failure mode)', () => {
    // This is what happens when `const INITIAL_DESTS = [` is removed
    // but the array body is left as orphaned syntax
    const code = `
      import { INITIAL_DESTS } from './destinations';
      { id: 'sofia', name: 'Sofia' },
      { id: 'lisbon', name: 'Lisbon' },
      ];
      function App() { return <div/>; }
    `;
    const result = checkBracketBalance(code);
    expect(result).not.toBeNull();
  });

  it('detects unexpected closing bracket', () => {
    const code = 'function foo() { return 1; }}';
    const result = checkBracketBalance(code);
    expect(result).not.toBeNull();
  });

  it('detects mismatched brackets', () => {
    const code = 'function foo() { return [1, 2); }';
    const result = checkBracketBalance(code);
    expect(result).not.toBeNull();
    expect(result).toContain('Mismatched');
  });

  it('handles empty code', () => {
    expect(checkBracketBalance('')).toBeNull();
  });

  it('handles regex literals without false positives', () => {
    const code = 'const re = /[a-z]{3}/g; const x = [1];';
    expect(checkBracketBalance(code)).toBeNull();
  });

  it('handles escaped characters in strings', () => {
    const code = "const x = 'it\\'s a \\\"test\\\"'; const y = [1];";
    expect(checkBracketBalance(code)).toBeNull();
  });
});

// ─── scanCrossFileReferences ────────────────────────────────────────────────

describe('scanCrossFileReferences', () => {
  const extraction: ExtractionCheck = {
    sourceFile: 'src/App.jsx',
    newFiles: ['src/utils.js'],
    extractedNames: ['clamp', 'fmt'],
    sourceInitialLineCount: null,
    newFileLineCount: null,
  };

  it('detects stale references in sibling files', async () => {
    const readFile = vi.fn(async (path: string) => {
      if (path === 'src/Header.jsx') {
        return "import { clamp } from './App';\nexport function Header() { return clamp(5); }";
      }
      return null;
    });
    const listFiles = vi.fn(async () => ['src/App.jsx', 'src/Header.jsx', 'src/utils.js']);

    const warnings = await scanCrossFileReferences(extraction, readFile, listFiles);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('STALE REFERENCES');
    expect(warnings[0]).toContain('Header.jsx');
    expect(warnings[0]).toContain('clamp');
  });

  it('ignores files that do not import from source', async () => {
    const readFile = vi.fn(async (path: string) => {
      if (path === 'src/Unrelated.jsx') {
        return "import React from 'react';\nexport function Unrelated() { return <div/>; }";
      }
      return null;
    });
    const listFiles = vi.fn(async () => ['src/App.jsx', 'src/Unrelated.jsx', 'src/utils.js']);

    const warnings = await scanCrossFileReferences(extraction, readFile, listFiles);
    expect(warnings).toHaveLength(0);
  });

  it('skips source file and new files from scan', async () => {
    const readFile = vi.fn(async () => null);
    const listFiles = vi.fn(async () => ['src/App.jsx', 'src/utils.js']);

    const warnings = await scanCrossFileReferences(extraction, readFile, listFiles);
    expect(warnings).toHaveLength(0);
    // readFile should NOT be called for excluded files
    expect(readFile).not.toHaveBeenCalled();
  });

  it('returns empty array when no extracted names', async () => {
    const noNames: ExtractionCheck = { ...extraction, extractedNames: [] };
    const readFile = vi.fn(async () => null);
    const listFiles = vi.fn(async () => ['src/Header.jsx']);

    const warnings = await scanCrossFileReferences(noNames, readFile, listFiles);
    expect(warnings).toHaveLength(0);
  });

  it('limits scan to 8 files', async () => {
    const readFile = vi.fn(async () => "import { something } from './App';");
    const listFiles = vi.fn(async () => [
      'src/App.jsx', 'src/utils.js', // excluded
      'src/A.jsx', 'src/B.jsx', 'src/C.jsx', 'src/D.jsx', 'src/E.jsx',
      'src/F.jsx', 'src/G.jsx', 'src/H.jsx', 'src/I.jsx', 'src/J.jsx',
    ]);

    await scanCrossFileReferences(extraction, readFile, listFiles);
    // Should read at most 8 files (covers parent dirs too)
    expect(readFile.mock.calls.length).toBeLessThanOrEqual(8);
  });

  it('handles listFiles failure gracefully', async () => {
    const readFile = vi.fn(async () => null);
    const listFiles = vi.fn(async () => { throw new Error('API error'); });

    const warnings = await scanCrossFileReferences(extraction, readFile, listFiles);
    expect(warnings).toHaveLength(0);
  });

  it('detects stale references in parent directory (PR #110 regression)', async () => {
    // Simulates: Section extracted from src/components/UIAtoms.jsx to src/components/Section.jsx
    // but src/App.jsx (parent dir) still imports Section from UIAtoms
    const nestedExtraction: ExtractionCheck = {
      sourceFile: 'src/components/UIAtoms.jsx',
      newFiles: ['src/components/Section.jsx'],
      extractedNames: ['Section'],
      sourceInitialLineCount: null,
      newFileLineCount: null,
    };

    const readFile = vi.fn(async (path: string) => {
      if (path === 'src/App.jsx') {
        return "import { Section, KPI, Slider } from './components/UIAtoms';\nexport default function App() { return <Section />; }";
      }
      return null;
    });
    const listFiles = vi.fn(async (dir: string) => {
      if (dir === 'src/components') return ['src/components/UIAtoms.jsx', 'src/components/Section.jsx', 'src/components/Other.jsx'];
      if (dir === 'src') return ['src/App.jsx', 'src/index.js'];
      return [];
    });

    const warnings = await scanCrossFileReferences(nestedExtraction, readFile, listFiles);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('STALE REFERENCES');
    expect(warnings[0]).toContain('App.jsx');
    expect(warnings[0]).toContain('Section');
    expect(warnings[0]).toContain('Section.jsx');
    // Should include concrete fix suggestion with import line
    expect(warnings[0]).toContain('FIX:');
    expect(warnings[0]).toContain("import { Section, KPI, Slider } from './components/UIAtoms'");
  });
});

// ─── computeRelativeImportPath ───────────────────────────────────────────────

describe('computeRelativeImportPath', () => {
  it('handles same directory', () => {
    expect(computeRelativeImportPath('src/components/Grid.jsx', 'src/components/Section.jsx'))
      .toBe('./Section.jsx');
  });

  it('handles child directory', () => {
    expect(computeRelativeImportPath('src/App.jsx', 'src/components/Section.jsx'))
      .toBe('./components/Section.jsx');
  });

  it('handles sibling directories', () => {
    expect(computeRelativeImportPath('src/pages/Dashboard.jsx', 'src/components/Section.jsx'))
      .toBe('../components/Section.jsx');
  });

  it('handles deeply nested to shallow', () => {
    expect(computeRelativeImportPath('src/components/sub/Deep.jsx', 'src/utils/helpers.js'))
      .toBe('../../utils/helpers.js');
  });

  it('handles root-level consumer', () => {
    expect(computeRelativeImportPath('App.jsx', 'src/components/Section.jsx'))
      .toBe('./src/components/Section.jsx');
  });

  it('handles both at root', () => {
    expect(computeRelativeImportPath('index.js', 'utils.js'))
      .toBe('./utils.js');
  });

  it('handles cross-top-level directories', () => {
    expect(computeRelativeImportPath('tests/App.test.jsx', 'src/components/Section.jsx'))
      .toBe('../src/components/Section.jsx');
  });

  it('handles deep nesting with common prefix', () => {
    expect(computeRelativeImportPath('a/b/c/d.js', 'a/x.js'))
      .toBe('../../x.js');
  });
});

// ─── verifyExtraction — syntax check ────────────────────────────────────────

describe('verifyExtraction — syntax check', () => {
  it('detects syntax corruption (orphaned array body, PR #79 pattern)', async () => {
    const extraction: ExtractionCheck = {
      sourceFile: 'src/App.jsx',
      newFiles: ['src/destinations.js'],
      extractedNames: [],
      sourceInitialLineCount: null,
      newFileLineCount: null,
    };

    const readFile = vi.fn(async (path: string) => {
      if (path === 'src/App.jsx') {
        // The `const INITIAL_DESTS = [` was removed but array body left behind
        return `import { INITIAL_DESTS } from './destinations';
  { id: 'sofia', name: 'Sofia', budget: 1200 },
  { id: 'lisbon', name: 'Lisbon', budget: 1500 },
];
function App() { return <div/>; }`;
      }
      if (path === 'src/destinations.js') {
        return 'export const INITIAL_DESTS = [{ id: "sofia" }];';
      }
      return null;
    });

    const result = await verifyExtraction(extraction, readFile);
    expect(result.passed).toBe(false);
    expect(result.issues.some(i => i.includes('SYNTAX CORRUPTION'))).toBe(true);
  });
});

// ─── formatVerificationForContext ───────────────────────────────────────────

describe('formatVerificationForContext', () => {
  it('formats passing verification', () => {
    const v: ExtractionVerification = {
      passed: true,
      issues: [],
      summary: 'All good',
    };
    const msg = formatVerificationForContext(v);
    expect(msg).toContain('PASSED');
    expect(msg).toContain('verified state');
  });

  it('formats failing verification with issues', () => {
    const v: ExtractionVerification = {
      passed: false,
      issues: ['identifiers still in source'],
      summary: 'EXTRACTION ISSUES DETECTED',
    };
    const msg = formatVerificationForContext(v);
    expect(msg).toContain('ISSUES FOUND');
    expect(msg).toContain('MUST reflect these findings');
  });
});
