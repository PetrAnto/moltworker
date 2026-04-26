/**
 * Audit Skill — Analyst orchestrator tests
 *
 * Mocks the LLM so we can drive the response and assert orchestration
 * (prompt assembly, validation hand-off, telemetry, no-snippets short-circuit,
 * LLM-error degradation).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../llm', () => ({
  callSkillLLM: vi.fn(),
  selectSkillModel: vi.fn((req: string | undefined, def: string) => req ?? def),
}));

import { analyzeWithLens } from './analyst';
import { callSkillLLM } from '../../llm';
import type { ExtractedSnippet, RepoProfile } from '../types';
import type { MoltbotEnv } from '../../../types';

const mockCall = vi.mocked(callSkillLLM);

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

function snippet(path: string): ExtractedSnippet {
  return {
    path, kind: 'function', name: 'demo',
    startLine: 1, endLine: 5,
    text: 'function demo() { return 1; }',
    language: 'typescript',
  };
}

const env = { OPENROUTER_API_KEY: 'k' } as unknown as MoltbotEnv;

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

describe('analyzeWithLens — orchestration', () => {
  it('short-circuits with no LLM call when snippets are empty', async () => {
    const r = await analyzeWithLens({
      profile: profileFor(['src/x.ts']),
      snippets: [],
      lens: 'security',
      env,
    });
    expect(mockCall).not.toHaveBeenCalled();
    expect(r.findings).toEqual([]);
    expect(r.telemetry.llmCalled).toBe(false);
  });

  it('builds a prompt that includes the path enum and the snippets, then validates the response', async () => {
    const profile = profileFor(['src/auth.ts']);
    mockCall.mockResolvedValueOnce({
      text: JSON.stringify({
        findings: [{
          lens: 'security', severity: 'high', confidence: 0.75,
          symptom: 'Hardcoded secret',
          rootCause: 'No pre-commit secret scan',
          correctiveAction: 'Move to env var',
          preventiveAction: { kind: 'ci', detail: 'Add gitleaks step' },
          evidence: [{ path: 'src/auth.ts', lines: '1-5', snippet: 'function demo()' }],
        }],
      }),
      tokens: { prompt: 100, completion: 50 },
    });

    const r = await analyzeWithLens({
      profile,
      snippets: [snippet('src/auth.ts')],
      lens: 'security',
      env,
    });

    expect(mockCall).toHaveBeenCalledTimes(1);
    const call = mockCall.mock.calls[0][0];
    expect(call.systemPrompt).toContain('DMAIC');
    expect(call.userPrompt).toContain('TREE');
    expect(call.userPrompt).toContain('src/auth.ts');
    expect(call.userPrompt).toContain('SNIPPETS');
    expect(call.responseFormat).toEqual({ type: 'json_object' });
    expect(call.temperature).toBe(0); // reproducibility

    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].lens).toBe('security');
    expect(r.telemetry.llmCalled).toBe(true);
    expect(r.telemetry.tokens).toEqual({ prompt: 100, completion: 50 });
  });

  it('passes the systemPromptOverride through (R2 hot-prompt path)', async () => {
    mockCall.mockResolvedValueOnce({ text: JSON.stringify({ findings: [] }) });
    await analyzeWithLens({
      profile: profileFor(['src/x.ts']),
      snippets: [snippet('src/x.ts')],
      lens: 'security',
      env,
      systemPromptOverride: 'CUSTOM SYSTEM PROMPT',
    });
    expect(mockCall.mock.calls[0][0].systemPrompt).toBe('CUSTOM SYSTEM PROMPT');
  });

  it('reports llm_call_failed (distinct from json_parse_failed) on upstream failure', async () => {
    mockCall.mockRejectedValueOnce(new Error('upstream 503'));
    const r = await analyzeWithLens({
      profile: profileFor(['src/x.ts']),
      snippets: [snippet('src/x.ts')],
      lens: 'security',
      env,
    });
    expect(r.findings).toEqual([]);
    expect(r.issues[0].kind).toBe('llm_call_failed');
    expect((r.issues[0] as { kind: 'llm_call_failed'; message: string }).message).toContain('upstream 503');
    expect(r.telemetry.llmCalled).toBe(true);
  });

  it('reports json_parse_failed (distinct from llm_call_failed) on bad JSON response', async () => {
    mockCall.mockResolvedValueOnce({ text: '{not valid json' });
    const r = await analyzeWithLens({
      profile: profileFor(['src/x.ts']),
      snippets: [snippet('src/x.ts')],
      lens: 'security',
      env,
    });
    expect(r.findings).toEqual([]);
    expect(r.issues[0].kind).toBe('json_parse_failed');
  });

  it('drops findings the LLM tried to attribute to a forged path (path-enum guard end-to-end)', async () => {
    mockCall.mockResolvedValueOnce({
      text: JSON.stringify({
        findings: [{
          lens: 'security', severity: 'high', confidence: 0.75,
          symptom: 'Made-up defect',
          rootCause: 'Imaginary',
          correctiveAction: 'N/A',
          preventiveAction: { kind: 'lint', detail: 'rule' },
          // src/imaginary.ts is NOT in the profile.tree
          evidence: [{ path: 'src/imaginary.ts', lines: '1-1', snippet: '' }],
        }],
      }),
    });

    const r = await analyzeWithLens({
      profile: profileFor(['src/real.ts']),
      snippets: [snippet('src/real.ts')],
      lens: 'security',
      env,
    });
    expect(r.findings).toEqual([]);
    expect(r.issues.some(i => i.kind === 'evidence_path_forged' || i.kind === 'finding_left_with_no_evidence')).toBe(true);
  });
});
