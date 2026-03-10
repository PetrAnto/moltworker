import { describe, it, expect, vi } from 'vitest';
import {
  isExtractionTask,
  detectExtractionDetails,
  verifyExtraction,
  formatVerificationForContext,
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
});

// ─── detectExtractionDetails ────────────────────────────────────────────────

describe('detectExtractionDetails', () => {
  it('detects workspace_write_file + github_create_pr with patch as extraction', () => {
    const messages: ChatMessage[] = [
      assistantWithTools(null, [{
        id: 'tc1',
        name: 'workspace_write_file',
        args: JSON.stringify({ path: 'src/utils.js', content: 'export function clamp(v) { return v; }', action: 'create' }),
      }]),
      toolResult('tc1', 'File staged: src/utils.js'),
      assistantWithTools(null, [{
        id: 'tc2',
        name: 'github_create_pr',
        args: JSON.stringify({
          owner: 'user', repo: 'app', branch: 'refactor',
          changes: [{
            path: 'src/App.jsx',
            action: 'patch',
            patches: [
              { find: 'function clamp(v) { return v; }', replace: "import { clamp } from './utils'" },
            ],
          }],
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

  it('filters out ROADMAP.md and WORK_LOG.md from source files', () => {
    const messages: ChatMessage[] = [
      assistantWithTools(null, [{
        id: 'tc1',
        name: 'workspace_write_file',
        args: JSON.stringify({ path: 'src/helpers.js', content: 'export const fmt = () => {}', action: 'create' }),
      }]),
      toolResult('tc1', 'Staged'),
      assistantWithTools(null, [{
        id: 'tc2',
        name: 'github_create_pr',
        args: JSON.stringify({
          owner: 'user', repo: 'app', branch: 'split',
          changes: [
            { path: 'src/App.jsx', action: 'patch', patches: [{ find: 'const fmt = () => {}', replace: "import { fmt } from './helpers'" }] },
            { path: 'ROADMAP.md', action: 'patch', patches: [{ find: '- [ ]', replace: '- [x]' }] },
            { path: 'WORK_LOG.md', action: 'patch', patches: [{ find: '| ---', replace: '| --- |' }] },
          ],
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
          changes: [{ path: 'src/App.jsx', action: 'patch', patches: [{ find: 'old', replace: 'new' }] }],
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
        args: JSON.stringify({ path: 'src/new-module.js', content: 'export default {}', action: 'create' }),
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
    };

    const readFile = vi.fn(async (path: string) => {
      if (path === 'src/App.jsx') return "import { DESTS } from './data';\nfunction App() {}";
      if (path === 'src/data.js') return 'export const DESTS = [];';
      return null;
    });

    const result = await verifyExtraction(extraction, readFile);
    expect(result.passed).toBe(true);
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
