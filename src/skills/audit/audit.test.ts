/**
 * Audit Skill — Handler tests
 *
 * Mocks `fetch` at the module boundary so we exercise the Scout pipeline
 * end-to-end without hitting the real GitHub API.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the LLM at the analyst's import boundary so handler-level tests
// can exercise the --analyze pipeline without hitting OpenRouter.
vi.mock('../llm', () => ({
  callSkillLLM: vi.fn(),
  selectSkillModel: vi.fn((req: string | undefined, def: string) => req ?? def),
}));

import {
  handleAudit, audit_do_key, buildOrchestraTask, buildFixSummary, resolveFix,
  buildScheduledAuditRequest,
} from './audit';
import { parseRepoCoords, encodeRepoPath } from './scout';
import { parseCommandMessage } from '../command-map';
import { fileMatchesLens, depthBudget } from './lenses';
import { profileCacheKey } from './cache';
import { findingPriority, isLens, isDepth } from './types';
import { callSkillLLM } from '../llm';
import type { AuditPlan, AuditRun, RepoProfile, AuditFinding, TreeEntry } from './types';
import type { SkillRequest } from '../types';
import type { MoltbotEnv } from '../../types';

const mockLLM = vi.mocked(callSkillLLM);

// ---------------------------------------------------------------------------
// fetch mock helpers
// ---------------------------------------------------------------------------

interface MockResp {
  match: (url: string) => boolean;
  status?: number;
  body: unknown;
}

function installFetchMock(routes: MockResp[]): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (url: string | Request) => {
    const u = typeof url === 'string' ? url : url.url;
    for (const r of routes) {
      if (r.match(u)) {
        const status = r.status ?? 200;
        return new Response(JSON.stringify(r.body), { status });
      }
    }
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function makeRequest(overrides?: Partial<SkillRequest>): SkillRequest {
  return {
    skillId: 'audit',
    subcommand: 'plan',
    text: 'octocat/hello-world',
    flags: {},
    transport: 'telegram',
    userId: '1',
    env: {
      GITHUB_TOKEN: 'tok',
      MOLTBOT_BUCKET: undefined as unknown as R2Bucket,
      OPENROUTER_API_KEY: 'k',
    } as unknown as MoltbotEnv,
    ...overrides,
  };
}

const SAMPLE_TREE = [
  { path: 'package.json', type: 'blob', sha: 'a1', size: 200 },
  { path: 'tsconfig.json', type: 'blob', sha: 'a2', size: 100 },
  { path: 'src/index.ts', type: 'blob', sha: 'a3', size: 1500 },
  { path: 'src/auth/login.ts', type: 'blob', sha: 'a4', size: 800 },
  { path: 'src/routes/api.ts', type: 'blob', sha: 'a5', size: 1200 },
  { path: 'src/types.d.ts', type: 'blob', sha: 'a6', size: 100 },
  { path: 'node_modules/lodash/index.js', type: 'blob', sha: 'a7', size: 50000 },
  { path: 'dist/bundle.min.js', type: 'blob', sha: 'a8', size: 99999 },
  { path: 'src/utils.ts', type: 'blob', sha: 'a9', size: 600 },
];

function mockGitHub() {
  return installFetchMock([
    {
      match: (u) => /\/repos\/[^/]+\/[^/]+$/.test(u),
      body: {
        default_branch: 'main', private: false, archived: false,
        size: 1024, language: 'TypeScript', description: 'demo',
      },
    },
    {
      match: (u) => /\/repos\/[^/]+\/[^/]+\/languages$/.test(u),
      body: { TypeScript: 12345, JavaScript: 678 },
    },
    {
      match: (u) => /\/git\/refs\/heads\//.test(u),
      body: { object: { sha: 'deadbeefcafebabe' } },
    },
    {
      match: (u) => /\/git\/trees\//.test(u),
      body: { truncated: false, tree: SAMPLE_TREE },
    },
    {
      match: (u) => u.includes('/contents/package.json'),
      body: {
        encoding: 'base64',
        content: btoa('{"name":"x"}'),
        sha: 'a1', size: 200,
      },
    },
    {
      match: (u) => u.includes('/contents/tsconfig.json'),
      body: {
        encoding: 'base64',
        content: btoa('{"compilerOptions":{"strict":true}}'),
        sha: 'a2', size: 100,
      },
    },
    // Code Scanning Alerts → 404 (disabled)
    {
      match: (u) => u.includes('/code-scanning/alerts'),
      status: 404,
      body: { message: 'Code scanning is not available' },
    },
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// parseRepoCoords
// ---------------------------------------------------------------------------

describe('encodeRepoPath (Contents API URL fix)', () => {
  it('preserves slashes between segments', () => {
    expect(encodeRepoPath('src/auth.ts')).toBe('src/auth.ts');
    expect(encodeRepoPath('packages/foo/src/index.ts')).toBe('packages/foo/src/index.ts');
    expect(encodeRepoPath('.github/workflows/deploy.yml')).toBe('.github/workflows/deploy.yml');
  });

  it('encodes individual segments with special characters', () => {
    expect(encodeRepoPath('src/file with space.ts')).toBe('src/file%20with%20space.ts');
    expect(encodeRepoPath('src/résumé.ts')).toBe('src/r%C3%A9sum%C3%A9.ts');
  });

  it('handles single-segment paths', () => {
    expect(encodeRepoPath('package.json')).toBe('package.json');
  });
});

describe('parseRepoCoords', () => {
  it('parses owner/repo shorthand', () => {
    expect(parseRepoCoords('octocat/hello-world')).toEqual({ owner: 'octocat', repo: 'hello-world' });
  });
  it('parses https github URL', () => {
    expect(parseRepoCoords('https://github.com/octocat/hello-world')).toEqual({ owner: 'octocat', repo: 'hello-world' });
  });
  it('parses URL with .git suffix', () => {
    expect(parseRepoCoords('https://github.com/octocat/hello-world.git')).toEqual({ owner: 'octocat', repo: 'hello-world' });
  });
  it('rejects non-github URLs', () => {
    expect(parseRepoCoords('https://gitlab.com/foo/bar')).toBeNull();
  });
  it('rejects junk', () => {
    expect(parseRepoCoords('not a repo')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fileMatchesLens
// ---------------------------------------------------------------------------

describe('fileMatchesLens', () => {
  const mk = (path: string, size = 100): TreeEntry => ({ path, type: 'blob', sha: 'x', size });

  it('skips vendored paths for every lens', () => {
    expect(fileMatchesLens(mk('node_modules/foo/bar.ts'), 'security')).toBe(false);
    expect(fileMatchesLens(mk('dist/x.js'), 'types')).toBe(false);
    expect(fileMatchesLens(mk('coverage/lcov.info'), 'tests')).toBe(false);
  });

  it('flags auth/middleware files for security lens', () => {
    expect(fileMatchesLens(mk('src/auth/login.ts'), 'security')).toBe(true);
    expect(fileMatchesLens(mk('src/middleware/cors.ts'), 'security')).toBe(true);
    expect(fileMatchesLens(mk('.github/workflows/deploy.yml'), 'security')).toBe(true);
  });

  it('flags TS source files for types lens but not .d.ts', () => {
    expect(fileMatchesLens(mk('src/foo.ts'), 'types')).toBe(true);
    expect(fileMatchesLens(mk('src/types.d.ts'), 'types')).toBe(false);
  });

  it('skips tree entries (only blobs match)', () => {
    expect(fileMatchesLens({ path: 'src', type: 'tree', sha: 'x' }, 'security')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// depthBudget + type guards
// ---------------------------------------------------------------------------

describe('depthBudget', () => {
  it('scales linearly across depths', () => {
    expect(depthBudget('quick').maxLlmCalls).toBeLessThan(depthBudget('standard').maxLlmCalls);
    expect(depthBudget('standard').maxLlmCalls).toBeLessThan(depthBudget('deep').maxLlmCalls);
  });
});

describe('type guards', () => {
  it('isLens accepts MVP lenses, rejects others', () => {
    expect(isLens('security')).toBe(true);
    expect(isLens('drift')).toBe(false);
    expect(isLens(42)).toBe(false);
  });
  it('isDepth accepts the three tiers', () => {
    expect(isDepth('quick')).toBe(true);
    expect(isDepth('standard')).toBe(true);
    expect(isDepth('deep')).toBe(true);
    expect(isDepth('shallow')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findingPriority
// ---------------------------------------------------------------------------

describe('findingPriority', () => {
  const mkFinding = (severity: AuditFinding['severity'], confidence: AuditFinding['confidence']): AuditFinding => ({
    id: 'x', lens: 'security', severity, confidence,
    evidence: [{ path: 'a', source: 'github' }],
    symptom: '', rootCause: '', correctiveAction: '',
    preventiveAction: { kind: 'lint', detail: '' },
  });
  it('ranks critical/high above low', () => {
    expect(findingPriority(mkFinding('critical', 1.0))).toBeGreaterThan(findingPriority(mkFinding('low', 1.0)));
  });
  it('uses confidence as a tiebreaker', () => {
    expect(findingPriority(mkFinding('high', 1.0))).toBeGreaterThan(findingPriority(mkFinding('high', 0.25)));
  });
});

// ---------------------------------------------------------------------------
// profileCacheKey
// ---------------------------------------------------------------------------

describe('profileCacheKey', () => {
  it('includes owner/repo/sha and is case-normalized', () => {
    expect(profileCacheKey('Octocat', 'Hello', 'abc123')).toBe('audit:profile:octocat/hello@abc123');
  });
});

// ---------------------------------------------------------------------------
// handleAudit (full flow with mocked fetch)
// ---------------------------------------------------------------------------

describe('handleAudit', () => {
  it('rejects empty input', async () => {
    const r = await handleAudit(makeRequest({ text: '' }));
    expect(r.kind).toBe('error');
    expect(r.body).toContain('Usage');
  });

  it('rejects unparseable repo', async () => {
    const r = await handleAudit(makeRequest({ text: 'just a sentence' }));
    expect(r.kind).toBe('error');
    expect(r.body).toContain('parse');
  });

  it('returns an audit_plan when given a real repo', async () => {
    mockGitHub();
    const r = await handleAudit(makeRequest());
    expect(r.kind).toBe('audit_plan');

    const plan = r.data as AuditPlan;
    expect(plan.profile.owner).toBe('octocat');
    expect(plan.profile.repo).toBe('hello-world');
    expect(plan.profile.sha).toBe('deadbeefcafebabe');
    expect(plan.profile.tree.length).toBe(SAMPLE_TREE.length);
    expect(plan.profile.codeScanningAlerts).toEqual([]); // 404 → empty, not error
    expect(plan.lenses.length).toBeGreaterThan(0);

    // Selections must exclude vendored files
    for (const lens of plan.lenses) {
      for (const path of plan.selections[lens]) {
        expect(path).not.toMatch(/(^|\/)(node_modules|dist|build)\//);
      }
    }
  });

  it('respects --lens to narrow to a single lens', async () => {
    mockGitHub();
    const r = await handleAudit(makeRequest({ flags: { lens: 'security' } }));
    expect(r.kind).toBe('audit_plan');
    const plan = r.data as AuditPlan;
    expect(plan.lenses).toEqual(['security']);
    expect(plan.selections.security.length).toBeGreaterThan(0);
  });

  it('rejects unknown --lens', async () => {
    mockGitHub();
    const r = await handleAudit(makeRequest({ flags: { lens: 'bogus' } }));
    expect(r.kind).toBe('error');
    expect(r.body).toContain('Unknown --lens');
  });

  it('rejects unknown --depth', async () => {
    mockGitHub();
    const r = await handleAudit(makeRequest({ flags: { depth: 'sloppy' } }));
    expect(r.kind).toBe('error');
    expect(r.body).toContain('Unknown --depth');
  });

  it('surfaces Scout failures as error results, not throws', async () => {
    installFetchMock([]); // every URL returns 404
    const r = await handleAudit(makeRequest());
    expect(r.kind).toBe('error');
    expect(r.body).toContain('Scout');
  });

  it('reports api call count in telemetry', async () => {
    mockGitHub();
    const r = await handleAudit(makeRequest());
    expect(r.kind).toBe('audit_plan');
    // meta + languages + ref + tree + 2 manifests + alerts = 7
    expect(r.telemetry.toolCalls).toBeGreaterThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// Hardening: reproducibility — same SHA produces same profile hash
// ---------------------------------------------------------------------------

describe('reproducibility', () => {
  it('same SHA + same tree → identical profile hash across runs', async () => {
    mockGitHub();
    const r1 = await handleAudit(makeRequest());
    mockGitHub();
    const r2 = await handleAudit(makeRequest());
    const p1 = (r1.data as AuditPlan).profile;
    const p2 = (r2.data as AuditPlan).profile;
    expect(p1.profileHash).toBe(p2.profileHash);
    expect(p1.sha).toBe(p2.sha);
  });
});

// ---------------------------------------------------------------------------
// Pre-merge fixes from GPT review
// ---------------------------------------------------------------------------

describe('branch names with "/" (e.g. feature/audit-v1)', () => {
  it('does not URI-encode the slash separators in the ref path', async () => {
    let capturedRefUrl = '';
    installFetchMock([
      {
        match: (u) => /\/repos\/[^/]+\/[^/]+$/.test(u),
        body: { default_branch: 'main', private: false, archived: false, size: 1, language: 'TypeScript', description: null },
      },
      {
        match: (u) => /\/languages$/.test(u),
        body: {},
      },
      {
        match: (u) => {
          const isRef = /\/git\/refs\/heads\//.test(u);
          if (isRef) capturedRefUrl = u;
          return isRef;
        },
        body: { ref: 'refs/heads/feature/audit-v1', object: { sha: 'a'.repeat(40) } },
      },
      {
        match: (u) => /\/git\/trees\//.test(u),
        body: { truncated: false, tree: [] },
      },
      {
        match: (u) => u.includes('/code-scanning/alerts'),
        status: 404, body: {},
      },
    ]);

    const r = await handleAudit(makeRequest({ flags: { branch: 'feature/audit-v1' } }));
    expect(r.kind).toBe('audit_plan');
    // The slash MUST survive — encoded segments separated by literal "/"
    expect(capturedRefUrl).toContain('/git/refs/heads/feature/audit-v1');
    expect(capturedRefUrl).not.toContain('feature%2F');
  });

  it('handles ref-array responses (prefix-match) and picks the exact match', async () => {
    installFetchMock([
      {
        match: (u) => /\/repos\/[^/]+\/[^/]+$/.test(u),
        body: { default_branch: 'main', private: false, archived: false, size: 1, language: 'TypeScript', description: null },
      },
      { match: (u) => /\/languages$/.test(u), body: {} },
      {
        match: (u) => /\/git\/refs\/heads\//.test(u),
        // GitHub returns an array when the ref name is treated as a prefix
        body: [
          { ref: 'refs/heads/feature/audit-v10', object: { sha: 'b'.repeat(40) } },
          { ref: 'refs/heads/feature/audit-v1',  object: { sha: 'c'.repeat(40) } },
        ],
      },
      { match: (u) => /\/git\/trees\//.test(u), body: { truncated: false, tree: [] } },
      { match: (u) => u.includes('/code-scanning/alerts'), status: 404, body: {} },
    ]);

    const r = await handleAudit(makeRequest({ flags: { branch: 'feature/audit-v1' } }));
    expect(r.kind).toBe('audit_plan');
    const plan = r.data as AuditPlan;
    expect(plan.profile.sha).toBe('c'.repeat(40));
  });
});

describe('tree truncation', () => {
  it('sets profile.treeTruncated and surfaces a note in the plan', async () => {
    installFetchMock([
      {
        match: (u) => /\/repos\/[^/]+\/[^/]+$/.test(u),
        body: { default_branch: 'main', private: false, archived: false, size: 99999, language: 'TypeScript', description: null },
      },
      { match: (u) => /\/languages$/.test(u), body: { TypeScript: 1 } },
      {
        match: (u) => /\/git\/refs\/heads\//.test(u),
        body: { ref: 'refs/heads/main', object: { sha: 'd'.repeat(40) } },
      },
      {
        match: (u) => /\/git\/trees\//.test(u),
        body: { truncated: true, tree: SAMPLE_TREE.slice(0, 3) },
      },
      { match: (u) => u.includes('/code-scanning/alerts'), status: 404, body: {} },
    ]);

    const r = await handleAudit(makeRequest());
    expect(r.kind).toBe('audit_plan');
    const plan = r.data as AuditPlan;
    expect(plan.profile.treeTruncated).toBe(true);
    expect(r.body).toMatch(/truncated/i);
  });

  it('sets treeTruncated=false on a complete response', async () => {
    mockGitHub();
    const r = await handleAudit(makeRequest());
    const plan = r.data as AuditPlan;
    expect(plan.profile.treeTruncated).toBe(false);
  });
});

describe('Code Scanning alert pagination', () => {
  it('flags codeScanningAlertsTruncated when a full first page is returned', async () => {
    const fullPage = Array.from({ length: 50 }, (_, i) => ({
      number: i, state: 'open' as const,
      rule: { id: `rule-${i}`, severity: 'medium' },
      most_recent_instance: { location: { path: `src/x${i}.ts`, start_line: 1 } },
    }));
    installFetchMock([
      {
        match: (u) => /\/repos\/[^/]+\/[^/]+$/.test(u),
        body: { default_branch: 'main', private: false, archived: false, size: 1, language: 'TypeScript', description: null },
      },
      { match: (u) => /\/languages$/.test(u), body: {} },
      {
        match: (u) => /\/git\/refs\/heads\//.test(u),
        body: { ref: 'refs/heads/main', object: { sha: 'e'.repeat(40) } },
      },
      { match: (u) => /\/git\/trees\//.test(u), body: { truncated: false, tree: [] } },
      { match: (u) => u.includes('/code-scanning/alerts'), body: fullPage },
    ]);

    const r = await handleAudit(makeRequest());
    expect(r.kind).toBe('audit_plan');
    const plan = r.data as AuditPlan;
    expect(plan.profile.codeScanningAlerts.length).toBe(50);
    expect(plan.profile.codeScanningAlertsTruncated).toBe(true);
    expect(r.body).toMatch(/first page only/i);
  });

  it('does not flag truncation when fewer alerts are returned', async () => {
    mockGitHub();
    const r = await handleAudit(makeRequest());
    const plan = r.data as AuditPlan;
    expect(plan.profile.codeScanningAlertsTruncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// --analyze end-to-end (Scout -> fetch files -> Extractor -> Analyst -> render)
// ---------------------------------------------------------------------------

describe('handleAudit --analyze (end-to-end with mocked LLM)', () => {
  it('runs the full pipeline and returns an audit_run with findings + telemetry', async () => {
    // Fixture: repo with one source file that the LLM will flag.
    const sourceContent = `export function login(user: string, pass: string) {
  const TOKEN = 'sk_live_DEADBEEFCAFE';
  return TOKEN + user + pass;
}`;
    const tree = [
      { path: 'package.json', type: 'blob', sha: 'm0', size: 50 },
      { path: 'src/auth.ts', type: 'blob', sha: 'a1', size: sourceContent.length },
    ];
    installFetchMock([
      {
        match: (u) => /\/repos\/[^/]+\/[^/]+$/.test(u),
        body: { default_branch: 'main', private: false, archived: false, size: 1, language: 'TypeScript', description: null },
      },
      { match: (u) => /\/languages$/.test(u), body: { TypeScript: 1 } },
      {
        match: (u) => /\/git\/refs\/heads\//.test(u),
        body: { ref: 'refs/heads/main', object: { sha: 'b'.repeat(40) } },
      },
      { match: (u) => /\/git\/trees\//.test(u), body: { truncated: false, tree } },
      {
        match: (u) => u.includes('/contents/package.json'),
        body: { encoding: 'base64', content: btoa('{"name":"x"}'), sha: 'm0', size: 50 },
      },
      {
        match: (u) => u.includes('/contents/src/auth.ts'),
        body: { encoding: 'base64', content: btoa(sourceContent), sha: 'a1', size: sourceContent.length },
      },
      { match: (u) => u.includes('/code-scanning/alerts'), status: 404, body: {} },
    ]);

    // LLM returns one valid security finding citing src/auth.ts.
    mockLLM.mockResolvedValue({
      text: JSON.stringify({
        findings: [{
          lens: 'security', severity: 'high', confidence: 0.75,
          symptom: 'Hardcoded API token in login()',
          rootCause: 'Secret committed to repo; CI lacks pre-commit secret scan',
          correctiveAction: 'Move TOKEN to env var; rotate the leaked secret',
          preventiveAction: { kind: 'ci', detail: 'Add gitleaks step to .github/workflows/ci.yml' },
          evidence: [{ path: 'src/auth.ts', lines: '2-2', snippet: "const TOKEN = 'sk_live_…';" }],
        }],
      }),
      tokens: { prompt: 800, completion: 200 },
    });

    const result = await handleAudit(makeRequest({
      flags: { analyze: 'true', lens: 'security', depth: 'quick' },
    }));

    expect(result.kind).toBe('audit_run');
    const run = result.data as AuditRun;
    expect(run.findings).toHaveLength(1);
    expect(run.findings[0].lens).toBe('security');
    expect(run.findings[0].severity).toBe('high');
    expect(run.findings[0].evidence[0].path).toBe('src/auth.ts');
    expect(run.telemetry.llmCalls).toBe(1);
    expect(run.telemetry.tokensIn).toBe(800);
    expect(run.telemetry.tokensOut).toBe(200);
    expect(result.body).toContain('Hardcoded API token');
    expect(result.body).toContain('gitleaks');
  });

  it('drops findings whose evidence cites paths outside the tree (anti-hallucination at handler level)', async () => {
    const tree = [{ path: 'src/real.ts', type: 'blob', sha: 'a1', size: 30 }];
    installFetchMock([
      {
        match: (u) => /\/repos\/[^/]+\/[^/]+$/.test(u),
        body: { default_branch: 'main', private: false, archived: false, size: 1, language: 'TypeScript', description: null },
      },
      { match: (u) => /\/languages$/.test(u), body: { TypeScript: 1 } },
      { match: (u) => /\/git\/refs\/heads\//.test(u), body: { ref: 'refs/heads/main', object: { sha: 'c'.repeat(40) } } },
      { match: (u) => /\/git\/trees\//.test(u), body: { truncated: false, tree } },
      {
        match: (u) => u.includes('/contents/src/real.ts'),
        body: { encoding: 'base64', content: btoa('export const x = 1;'), sha: 'a1', size: 30 },
      },
      { match: (u) => u.includes('/code-scanning/alerts'), status: 404, body: {} },
    ]);

    mockLLM.mockResolvedValue({
      text: JSON.stringify({
        findings: [{
          lens: 'security', severity: 'high', confidence: 0.75,
          symptom: 'Defect in a file that does not exist',
          rootCause: 'Imaginary',
          correctiveAction: 'N/A',
          preventiveAction: { kind: 'lint', detail: 'rule body' },
          evidence: [{ path: 'src/imaginary.ts', lines: '1-1', snippet: 'fake' }],
        }],
      }),
    });

    const result = await handleAudit(makeRequest({
      flags: { analyze: 'true', lens: 'security' },
    }));
    expect(result.kind).toBe('audit_run');
    const run = result.data as AuditRun;
    expect(run.findings).toEqual([]); // forged path → dropped
    expect(result.body).toContain('No defects found');
  });

  it('drops low-confidence findings (precision discipline)', async () => {
    // Include both src/auth.ts (security lens match) AND package.json (a
    // manifest the Scout always pre-fetches). The manifest snippet alone
    // ensures the Analyst gets called even if grammar loading is unavailable.
    const tree = [
      { path: 'package.json', type: 'blob', sha: 'm0', size: 30 },
      { path: 'src/auth.ts', type: 'blob', sha: 'a1', size: 30 },
    ];
    installFetchMock([
      { match: (u) => /\/repos\/[^/]+\/[^/]+$/.test(u), body: { default_branch: 'main', private: false, archived: false, size: 1, language: 'TypeScript', description: null } },
      { match: (u) => /\/languages$/.test(u), body: {} },
      { match: (u) => /\/git\/refs\/heads\//.test(u), body: { ref: 'refs/heads/main', object: { sha: 'd'.repeat(40) } } },
      { match: (u) => /\/git\/trees\//.test(u), body: { truncated: false, tree } },
      { match: (u) => u.includes('/contents/package.json'), body: { encoding: 'base64', content: btoa('{"name":"x"}'), sha: 'm0', size: 30 } },
      { match: (u) => u.includes('/contents/src/auth.ts'), body: { encoding: 'base64', content: btoa('export const x = 1;'), sha: 'a1', size: 30 } },
      { match: (u) => u.includes('/code-scanning/alerts'), status: 404, body: {} },
    ]);

    mockLLM.mockResolvedValue({
      text: JSON.stringify({
        findings: [
          { lens: 'security', severity: 'high', confidence: 0.25,
            symptom: 'Speculative finding',
            rootCause: 'Maybe', correctiveAction: 'Try',
            preventiveAction: { kind: 'doc', detail: '...' },
            evidence: [{ path: 'src/auth.ts', lines: '1-1', snippet: 'export' }] },
          { lens: 'security', severity: 'medium', confidence: 0.75,
            symptom: 'Real-looking finding',
            rootCause: 'Cause', correctiveAction: 'Fix',
            preventiveAction: { kind: 'lint', detail: 'rule' },
            evidence: [{ path: 'src/auth.ts', lines: '1-1', snippet: 'export' }] },
        ],
      }),
    });

    const result = await handleAudit(makeRequest({
      flags: { analyze: 'true', lens: 'security' },
    }));
    const run = result.data as AuditRun;
    expect(run.findings).toHaveLength(1);
    expect(run.findings[0].symptom).toBe('Real-looking finding');
  });
});

// ---------------------------------------------------------------------------
// Pre-merge fixes from GPT slice-2 review
// ---------------------------------------------------------------------------

describe('--analyze: GitHub Contents API URL encoding (path fix)', () => {
  it('builds /contents/<path> URLs with literal slashes for nested files', async () => {
    // Capture every URL that hits the Contents API; assert none of them
    // have %2F separators.
    const contentUrls: string[] = [];
    installFetchMock([
      { match: (u) => /\/repos\/[^/]+\/[^/]+$/.test(u), body: { default_branch: 'main', private: false, archived: false, size: 1, language: 'TypeScript', description: null } },
      { match: (u) => /\/languages$/.test(u), body: {} },
      { match: (u) => /\/git\/refs\/heads\//.test(u), body: { ref: 'refs/heads/main', object: { sha: 'a'.repeat(40) } } },
      {
        match: (u) => /\/git\/trees\//.test(u),
        body: {
          truncated: false,
          tree: [
            { path: 'package.json', type: 'blob', sha: 's0', size: 50 },
            { path: 'src/auth/login.ts', type: 'blob', sha: 's1', size: 100 },
          ],
        },
      },
      {
        match: (u) => {
          if (u.includes('/contents/')) contentUrls.push(u);
          return /\/contents\//.test(u);
        },
        body: { encoding: 'base64', content: btoa('{"name":"x"}'), sha: 's0', size: 50 },
      },
      { match: (u) => u.includes('/code-scanning/alerts'), status: 404, body: {} },
    ]);

    mockLLM.mockResolvedValue({ text: JSON.stringify({ findings: [] }) });
    await handleAudit(makeRequest({
      flags: { analyze: 'true', lens: 'security' },
    }));

    // Every Contents URL must keep '/'  literal — that's the regression.
    for (const u of contentUrls) {
      expect(u).not.toContain('%2F');
      expect(u).not.toContain('%2f');
    }
    // We DID hit /contents/ (sanity).
    expect(contentUrls.length).toBeGreaterThan(0);
  });
});

describe('--analyze: inline budget guard', () => {
  it('refuses inline runs that exceed INLINE_MAX_FILES', async () => {
    // Build a tree where deep depth selects > 25 files of a security-matching shape.
    const tree = Array.from({ length: 60 }, (_, i) => ({
      path: `src/auth/h${i}.ts`,
      type: 'blob' as const,
      sha: `s${i}`,
      size: 100,
    }));
    installFetchMock([
      { match: (u) => /\/repos\/[^/]+\/[^/]+$/.test(u), body: { default_branch: 'main', private: false, archived: false, size: 1, language: 'TypeScript', description: null } },
      { match: (u) => /\/languages$/.test(u), body: {} },
      { match: (u) => /\/git\/refs\/heads\//.test(u), body: { ref: 'refs/heads/main', object: { sha: 'a'.repeat(40) } } },
      { match: (u) => /\/git\/trees\//.test(u), body: { truncated: false, tree } },
      { match: (u) => u.includes('/code-scanning/alerts'), status: 404, body: {} },
    ]);

    const result = await handleAudit(makeRequest({
      flags: { analyze: 'true', lens: 'security', depth: 'deep' },
    }));
    expect(result.kind).toBe('error');
    expect(result.body).toMatch(/too large for inline/i);
    // LLM must NOT have been called (we refused before any work).
    expect(mockLLM).not.toHaveBeenCalled();
  });
});

describe('--analyze: fetched-file SHA validation', () => {
  it('skips files where the fetched SHA disagrees with the tree SHA', async () => {
    const tree = [
      { path: 'package.json', type: 'blob', sha: 'TREE_SHA_PACKAGE', size: 30 },
      { path: 'src/auth.ts', type: 'blob', sha: 'TREE_SHA_AUTH', size: 30 },
    ];
    installFetchMock([
      { match: (u) => /\/repos\/[^/]+\/[^/]+$/.test(u), body: { default_branch: 'main', private: false, archived: false, size: 1, language: 'TypeScript', description: null } },
      { match: (u) => /\/languages$/.test(u), body: {} },
      { match: (u) => /\/git\/refs\/heads\//.test(u), body: { ref: 'refs/heads/main', object: { sha: 'a'.repeat(40) } } },
      { match: (u) => /\/git\/trees\//.test(u), body: { truncated: false, tree } },
      // package.json: SHA matches → kept
      { match: (u) => u.includes('/contents/package.json'), body: { encoding: 'base64', content: btoa('{"name":"x"}'), sha: 'TREE_SHA_PACKAGE', size: 30 } },
      // src/auth.ts: SHA disagrees → skipped
      { match: (u) => u.includes('/contents/src/auth.ts'), body: { encoding: 'base64', content: btoa('export const x = 1;'), sha: 'WRONG_SHA', size: 30 } },
      { match: (u) => u.includes('/code-scanning/alerts'), status: 404, body: {} },
    ]);

    mockLLM.mockResolvedValue({ text: JSON.stringify({ findings: [] }) });
    const result = await handleAudit(makeRequest({
      flags: { analyze: 'true', lens: 'security' },
    }));
    expect(result.kind).toBe('audit_run');
    // The user-visible body surfaces the mismatch warning.
    expect(result.body).toMatch(/SHA disagreed/);
  });
});

describe('--analyze: preventive artifact formatting', () => {
  it('renders kind + first line + export hint when artifact is multi-line', async () => {
    const tree = [
      { path: 'package.json', type: 'blob', sha: 'm0', size: 30 },
      { path: 'src/auth.ts', type: 'blob', sha: 'a1', size: 30 },
    ];
    installFetchMock([
      { match: (u) => /\/repos\/[^/]+\/[^/]+$/.test(u), body: { default_branch: 'main', private: false, archived: false, size: 1, language: 'TypeScript', description: null } },
      { match: (u) => /\/languages$/.test(u), body: {} },
      { match: (u) => /\/git\/refs\/heads\//.test(u), body: { ref: 'refs/heads/main', object: { sha: 'd'.repeat(40) } } },
      { match: (u) => /\/git\/trees\//.test(u), body: { truncated: false, tree } },
      { match: (u) => u.includes('/contents/package.json'), body: { encoding: 'base64', content: btoa('{"name":"x"}'), sha: 'm0', size: 30 } },
      { match: (u) => u.includes('/contents/src/auth.ts'), body: { encoding: 'base64', content: btoa('export const x = 1;'), sha: 'a1', size: 30 } },
      { match: (u) => u.includes('/code-scanning/alerts'), status: 404, body: {} },
    ]);

    const multiLineArtifact = `name: secret-scan
on: [push, pull_request]
jobs:
  gitleaks:
    runs-on: ubuntu-latest
    steps:
      - uses: gitleaks/gitleaks-action@v2`;
    mockLLM.mockResolvedValue({
      text: JSON.stringify({
        findings: [{
          lens: 'security', severity: 'high', confidence: 0.75,
          symptom: 'Hardcoded token',
          rootCause: 'No pre-commit secret scan',
          correctiveAction: 'Move to env',
          preventiveAction: { kind: 'ci', detail: multiLineArtifact },
          evidence: [{ path: 'src/auth.ts', lines: '1-1', snippet: 'export' }],
        }],
      }),
    });

    const result = await handleAudit(makeRequest({
      flags: { analyze: 'true', lens: 'security' },
    }));
    // The first line is preserved, kind is shown, and we point to /audit export
    // for the full artifact rather than truncating mid-content.
    expect(result.body).toContain('[ci]');
    expect(result.body).toContain('name: secret-scan');
    expect(result.body).toMatch(/\/audit export/);
    // The middle of the artifact must NOT appear in the top-5 view —
    // that's the export's job.
    expect(result.body).not.toContain('gitleaks/gitleaks-action');
  });

  it('keeps single-line artifacts as-is without an export hint', async () => {
    const tree = [
      { path: 'package.json', type: 'blob', sha: 'm0', size: 30 },
      { path: 'src/auth.ts', type: 'blob', sha: 'a1', size: 30 },
    ];
    installFetchMock([
      { match: (u) => /\/repos\/[^/]+\/[^/]+$/.test(u), body: { default_branch: 'main', private: false, archived: false, size: 1, language: 'TypeScript', description: null } },
      { match: (u) => /\/languages$/.test(u), body: {} },
      { match: (u) => /\/git\/refs\/heads\//.test(u), body: { ref: 'refs/heads/main', object: { sha: 'e'.repeat(40) } } },
      { match: (u) => /\/git\/trees\//.test(u), body: { truncated: false, tree } },
      { match: (u) => u.includes('/contents/package.json'), body: { encoding: 'base64', content: btoa('{"name":"x"}'), sha: 'm0', size: 30 } },
      { match: (u) => u.includes('/contents/src/auth.ts'), body: { encoding: 'base64', content: btoa('export const x = 1;'), sha: 'a1', size: 30 } },
      { match: (u) => u.includes('/code-scanning/alerts'), status: 404, body: {} },
    ]);

    mockLLM.mockResolvedValue({
      text: JSON.stringify({
        findings: [{
          lens: 'security', severity: 'high', confidence: 0.75,
          symptom: 'X', rootCause: 'Y', correctiveAction: 'Z',
          preventiveAction: { kind: 'lint', detail: 'no-eval rule with description' },
          evidence: [{ path: 'src/auth.ts', lines: '1-1', snippet: 'export' }],
        }],
      }),
    });

    const result = await handleAudit(makeRequest({
      flags: { analyze: 'true', lens: 'security' },
    }));
    expect(result.body).toContain('[lint] no-eval rule with description');
    expect(result.body).not.toMatch(/\/audit export/);
  });
});

// ---------------------------------------------------------------------------
// Hardening from GPT slice-2 review of PR 505
// ---------------------------------------------------------------------------

describe('--analyze: bundled-fallback runtime (slice 5 cold-start path)', () => {
  it('proceeds with no MOLTBOT_BUCKET — uses the bundled runtime and surfaces "runtime: bundled"', async () => {
    // The whole point of slice 5: /audit --analyze must work without R2.
    // Bundled fallback is the always-present path. The body surfaces
    // "runtime: bundled" so operators can see which source was hot.
    const tree = [
      { path: 'package.json', type: 'blob', sha: 'm0', size: 30 },
      { path: 'src/auth.ts', type: 'blob', sha: 'a1', size: 30 },
    ];
    installFetchMock([
      { match: (u) => /\/repos\/[^/]+\/[^/]+$/.test(u), body: { default_branch: 'main', private: false, archived: false, size: 1, language: 'TypeScript', description: null } },
      { match: (u) => /\/languages$/.test(u), body: {} },
      { match: (u) => /\/git\/refs\/heads\//.test(u), body: { ref: 'refs/heads/main', object: { sha: 'a'.repeat(40) } } },
      { match: (u) => /\/git\/trees\//.test(u), body: { truncated: false, tree } },
      { match: (u) => u.includes('/contents/package.json'), body: { encoding: 'base64', content: btoa('{"name":"x"}'), sha: 'm0', size: 30 } },
      { match: (u) => u.includes('/contents/src/auth.ts'), body: { encoding: 'base64', content: btoa('export const x = 1;'), sha: 'a1', size: 30 } },
      { match: (u) => u.includes('/code-scanning/alerts'), status: 404, body: {} },
    ]);
    mockLLM.mockResolvedValue({ text: JSON.stringify({ findings: [] }) });

    const result = await handleAudit(makeRequest({
      flags: { analyze: 'true', lens: 'security' },
      // No MOLTBOT_BUCKET → R2 path returns null → bundled fallback used
    }));
    expect(result.kind).toBe('audit_run');
    expect(result.body).toContain('runtime: bundled');
  });

  it('surfaces an "R2 runtime unavailable" warning when R2 was configured but failed verification', async () => {
    // Closes GPT slice-5 review finding 2. R2 has a manifest with a
    // runtime entry whose declared SHA does not match the bytes —
    // simulates a half-complete or corrupted upload. The handler
    // should still complete via the bundled fallback, but the report
    // must distinctly say "R2 runtime unavailable" so the operator
    // doesn't think audit:upload-grammars succeeded.
    const tree = [
      { path: 'package.json', type: 'blob', sha: 'm0', size: 30 },
      { path: 'src/auth.ts', type: 'blob', sha: 'a1', size: 30 },
    ];
    // R2 with a runtime manifest entry whose SHA won't match.
    const fakeBucket = {
      get: vi.fn(async (key: string) => {
        if (key === 'audit/grammars/manifest.json') {
          // Manifest declares a runtime with sha=zeros; the bytes below
          // produce a real SHA → mismatch path triggers.
          return {
            json: async () => ({
              version: 1,
              entries: [],
              runtime: {
                key: 'audit/grammars/runtime@00000000.wasm',
                sha256: '0'.repeat(64),
                size: 8,
                source: 'fake',
                uploadedAt: 'now',
              },
              updatedAt: 'now',
            }),
            arrayBuffer: async () => new ArrayBuffer(0),
          } as unknown as R2ObjectBody;
        }
        if (key === 'audit/grammars/runtime@00000000.wasm') {
          return {
            json: async () => ({}),
            arrayBuffer: async () => new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]).buffer,
          } as unknown as R2ObjectBody;
        }
        return null;
      }),
      put: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(async () => ({ keys: [], list_complete: true, cursor: undefined })),
    } as unknown as R2Bucket;

    installFetchMock([
      { match: (u) => /\/repos\/[^/]+\/[^/]+$/.test(u), body: { default_branch: 'main', private: false, archived: false, size: 1, language: 'TypeScript', description: null } },
      { match: (u) => /\/languages$/.test(u), body: {} },
      { match: (u) => /\/git\/refs\/heads\//.test(u), body: { ref: 'refs/heads/main', object: { sha: 'a'.repeat(40) } } },
      { match: (u) => /\/git\/trees\//.test(u), body: { truncated: false, tree } },
      { match: (u) => u.includes('/contents/package.json'), body: { encoding: 'base64', content: btoa('{"name":"x"}'), sha: 'm0', size: 30 } },
      { match: (u) => u.includes('/contents/src/auth.ts'), body: { encoding: 'base64', content: btoa('export const x = 1;'), sha: 'a1', size: 30 } },
      { match: (u) => u.includes('/code-scanning/alerts'), status: 404, body: {} },
    ]);
    mockLLM.mockResolvedValue({ text: JSON.stringify({ findings: [] }) });

    // Reset the loader's per-isolate manifest cache so this test gets a
    // fresh fetch (other tests run before this one in the same file).
    const loader = await import('./grammars/loader');
    loader._resetGrammarCachesForTesting();

    const result = await handleAudit(makeRequest({
      flags: { analyze: 'true', lens: 'security' },
      env: { GITHUB_TOKEN: 'tok', OPENROUTER_API_KEY: 'k', MOLTBOT_BUCKET: fakeBucket } as unknown as MoltbotEnv,
    }));
    expect(result.kind).toBe('audit_run');
    // Used the bundled fallback (R2 was broken, not just unconfigured).
    expect(result.body).toContain('runtime: bundled');
    // Distinct warning so the operator can fix R2.
    expect(result.body).toMatch(/R2 runtime unavailable: sha_mismatch/);
  });
});

describe('--analyze: surfaces missing-grammar coverage warning', () => {
  it('reports which language grammars were missing and points at the uploader', async () => {
    // Provide MOLTBOT_BUCKET so the runtime gate doesn't fire, but no
    // grammars (loadGrammar returns null for every lang). Use a non-test
    // env spoof? No — under VITEST the gate is bypassed; we want the
    // grammar-unavailable path to exercise. We simulate that by giving
    // a bucket that returns null for everything (no manifest, no runtime).
    const tree = [
      { path: 'package.json', type: 'blob', sha: 'm0', size: 30 },
      { path: 'src/auth.ts', type: 'blob', sha: 'a1', size: 30 },
    ];
    installFetchMock([
      { match: (u) => /\/repos\/[^/]+\/[^/]+$/.test(u), body: { default_branch: 'main', private: false, archived: false, size: 1, language: 'TypeScript', description: null } },
      { match: (u) => /\/languages$/.test(u), body: {} },
      { match: (u) => /\/git\/refs\/heads\//.test(u), body: { ref: 'refs/heads/main', object: { sha: 'a'.repeat(40) } } },
      { match: (u) => /\/git\/trees\//.test(u), body: { truncated: false, tree } },
      { match: (u) => u.includes('/contents/package.json'), body: { encoding: 'base64', content: btoa('{"name":"x"}'), sha: 'm0', size: 30 } },
      { match: (u) => u.includes('/contents/src/auth.ts'), body: { encoding: 'base64', content: btoa('export const x = 1;'), sha: 'a1', size: 30 } },
      { match: (u) => u.includes('/code-scanning/alerts'), status: 404, body: {} },
    ]);

    // Bucket exists but has no manifest → loadGrammar returns null for
    // every language; loadRuntimeWasm also returns null.
    const emptyBucket = {
      get: vi.fn(async () => null),
    } as unknown as R2Bucket;

    mockLLM.mockResolvedValue({ text: JSON.stringify({ findings: [] }) });
    const result = await handleAudit(makeRequest({
      flags: { analyze: 'true', lens: 'security' },
      env: {
        GITHUB_TOKEN: 'tok',
        OPENROUTER_API_KEY: 'k',
        MOLTBOT_BUCKET: emptyBucket,
      } as unknown as MoltbotEnv,
    }));
    // VITEST is set, so the runtime gate is bypassed and we get to the
    // extractor — which records "grammar 'typescript' unavailable" for
    // src/auth.ts. The handler surfaces that as a coverage warning.
    expect(result.kind).toBe('audit_run');
    expect(result.body).toMatch(/coverage partial/i);
    expect(result.body).toContain('typescript');
    expect(result.body).toMatch(/audit:upload-grammars/);
  });
});

// ---------------------------------------------------------------------------
// Slice 3 — DO async dispatch (mirrors /dossier)
// ---------------------------------------------------------------------------

describe('--analyze: DO dispatch routing', () => {
  /** Build a tree large enough to exceed the inline envelope. */
  function bigTree() {
    return Array.from({ length: 60 }, (_, i) => ({
      path: `src/auth/h${i}.ts`, type: 'blob' as const, sha: `s${i}`, size: 100,
    }));
  }

  function installBigRepoFetchMock() {
    installFetchMock([
      { match: (u) => /\/repos\/[^/]+\/[^/]+$/.test(u), body: { default_branch: 'main', private: false, archived: false, size: 1, language: 'TypeScript', description: null } },
      { match: (u) => /\/languages$/.test(u), body: {} },
      { match: (u) => /\/git\/refs\/heads\//.test(u), body: { ref: 'refs/heads/main', object: { sha: 'a'.repeat(40) } } },
      { match: (u) => /\/git\/trees\//.test(u), body: { truncated: false, tree: bigTree() } },
      { match: (u) => u.includes('/code-scanning/alerts'), status: 404, body: {} },
    ]);
  }

  it('dispatches an oversize audit to the DO when TASK_PROCESSOR + telegram are available', async () => {
    installBigRepoFetchMock();
    const stub = { fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'started' }))) };
    const taskProcessor = {
      idFromName: vi.fn().mockReturnValue('do-id'),
      get: vi.fn().mockReturnValue(stub),
    };

    const result = await handleAudit(makeRequest({
      flags: { analyze: 'true', lens: 'security', depth: 'deep' },
      transport: 'telegram',
      chatId: 12345,
      context: { telegramToken: 'tg-token' },
      env: {
        GITHUB_TOKEN: 'tok', OPENROUTER_API_KEY: 'k',
        TASK_PROCESSOR: taskProcessor,
      } as unknown as MoltbotEnv,
    }));

    // Worker returns "started" immediately; the DO is what eventually
    // sends the report.
    expect(result.kind).toBe('text');
    expect(result.body).toMatch(/Audit started/i);
    expect((result.data as Record<string, unknown>).async).toBe(true);

    // DO was dispatched.
    expect(taskProcessor.idFromName).toHaveBeenCalled();
    expect(stub.fetch).toHaveBeenCalledWith(
      'https://do/process',
      expect.objectContaining({ method: 'POST' }),
    );
    // LLM never called from the worker side — that's the DO's job now.
    expect(mockLLM).not.toHaveBeenCalled();
  });

  it('strips env from the wire payload (no live bindings serialized)', async () => {
    installBigRepoFetchMock();
    const stub = { fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'started' }))) };
    const taskProcessor = {
      idFromName: vi.fn().mockReturnValue('do-id'),
      get: vi.fn().mockReturnValue(stub),
    };

    await handleAudit(makeRequest({
      flags: { analyze: 'true', lens: 'security', depth: 'deep' },
      transport: 'telegram',
      chatId: 12345,
      context: { telegramToken: 'tg-token' },
      env: {
        GITHUB_TOKEN: 'tok', OPENROUTER_API_KEY: 'k',
        TASK_PROCESSOR: taskProcessor,
      } as unknown as MoltbotEnv,
    }));

    const init = stub.fetch.mock.calls[0][1] as RequestInit;
    const payload = JSON.parse(init.body as string);
    // Wire contract: skillRequest.env MUST NOT carry bindings across the
    // boundary (they wouldn't survive JSON anyway, but sending undefined
    // makes any DO-side use crash loudly instead of silently using {}).
    expect(payload.skillRequest.env).toBeUndefined();
    // Secrets are passed explicitly so the DO can rebuild env on the other side.
    expect(payload.openrouterKey).toBe('k');
    expect(payload.githubToken).toBe('tok');
    // Full payload JSON-roundtrips cleanly (no functions, no Symbols).
    expect(() => JSON.parse(JSON.stringify(payload))).not.toThrow();
  });

  it('refuses oversize audits with no DO available (clear error)', async () => {
    installBigRepoFetchMock();
    const result = await handleAudit(makeRequest({
      flags: { analyze: 'true', lens: 'security', depth: 'deep' },
      transport: 'telegram',
      chatId: 12345,
      context: { telegramToken: 'tg-token' },
      env: {
        GITHUB_TOKEN: 'tok', OPENROUTER_API_KEY: 'k',
        // No TASK_PROCESSOR
      } as unknown as MoltbotEnv,
    }));
    expect(result.kind).toBe('error');
    expect(result.body).toMatch(/too large for inline/i);
    expect(mockLLM).not.toHaveBeenCalled();
  });

  it('refuses oversize audits when transport is not telegram (no DO target)', async () => {
    installBigRepoFetchMock();
    const stub = { fetch: vi.fn() };
    const taskProcessor = {
      idFromName: vi.fn().mockReturnValue('do-id'),
      get: vi.fn().mockReturnValue(stub),
    };
    const result = await handleAudit(makeRequest({
      flags: { analyze: 'true', lens: 'security', depth: 'deep' },
      transport: 'api', // not telegram → can't dispatch
      env: {
        GITHUB_TOKEN: 'tok', OPENROUTER_API_KEY: 'k',
        TASK_PROCESSOR: taskProcessor,
      } as unknown as MoltbotEnv,
    }));
    expect(result.kind).toBe('error');
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it('falls back to inline (no dispatch) when audit fits the inline envelope', async () => {
    // Small repo + depth=quick → inline path. DO is available but should
    // not be used.
    const tree = [
      { path: 'package.json', type: 'blob', sha: 'm0', size: 30 },
      { path: 'src/auth.ts', type: 'blob', sha: 'a1', size: 30 },
    ];
    installFetchMock([
      { match: (u) => /\/repos\/[^/]+\/[^/]+$/.test(u), body: { default_branch: 'main', private: false, archived: false, size: 1, language: 'TypeScript', description: null } },
      { match: (u) => /\/languages$/.test(u), body: {} },
      { match: (u) => /\/git\/refs\/heads\//.test(u), body: { ref: 'refs/heads/main', object: { sha: 'a'.repeat(40) } } },
      { match: (u) => /\/git\/trees\//.test(u), body: { truncated: false, tree } },
      { match: (u) => u.includes('/contents/package.json'), body: { encoding: 'base64', content: btoa('{"name":"x"}'), sha: 'm0', size: 30 } },
      { match: (u) => u.includes('/contents/src/auth.ts'), body: { encoding: 'base64', content: btoa('export const x = 1;'), sha: 'a1', size: 30 } },
      { match: (u) => u.includes('/code-scanning/alerts'), status: 404, body: {} },
    ]);
    mockLLM.mockResolvedValue({ text: JSON.stringify({ findings: [] }) });

    const stub = { fetch: vi.fn() };
    const taskProcessor = {
      idFromName: vi.fn().mockReturnValue('do-id'),
      get: vi.fn().mockReturnValue(stub),
    };

    const result = await handleAudit(makeRequest({
      flags: { analyze: 'true', lens: 'security', depth: 'quick' },
      transport: 'telegram',
      chatId: 12345,
      context: { telegramToken: 'tg-token' },
      env: {
        GITHUB_TOKEN: 'tok', OPENROUTER_API_KEY: 'k',
        TASK_PROCESSOR: taskProcessor,
      } as unknown as MoltbotEnv,
    }));

    // Inline path used: result is an audit_run, not the "started" text.
    expect(result.kind).toBe('audit_run');
    // DO was NEVER dispatched.
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it('runs inline (no re-dispatch loop) when context.runningInDO=true', async () => {
    // Simulates the DO-side invocation: runningInDO=true should bypass
    // both the dispatcher and the inline budget guard, going straight
    // to runFullAudit.
    installBigRepoFetchMock();
    mockLLM.mockResolvedValue({ text: JSON.stringify({ findings: [] }) });

    // Even though TASK_PROCESSOR is set, the DO context flag MUST take
    // precedence and run inline (otherwise we'd recurse forever).
    const stub = { fetch: vi.fn() };
    const taskProcessor = {
      idFromName: vi.fn().mockReturnValue('do-id'),
      get: vi.fn().mockReturnValue(stub),
    };

    const result = await handleAudit(makeRequest({
      flags: { analyze: 'true', lens: 'security', depth: 'deep' },
      transport: 'telegram',
      chatId: 12345,
      context: { telegramToken: 'tg-token', runningInDO: true },
      env: {
        GITHUB_TOKEN: 'tok', OPENROUTER_API_KEY: 'k',
        TASK_PROCESSOR: taskProcessor,
      } as unknown as MoltbotEnv,
    }));

    // Inline path executed (audit_run kind, not "started" text).
    expect(result.kind).toBe('audit_run');
    // Critical: NO re-dispatch attempt.
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it('falls back to inline when TASK_PROCESSOR is a hollow object (post-JSON binding)', async () => {
    // Defense in depth: if some path forwarded a dehydrated env (binding
    // arrived as {} after JSON serialization), audit must detect the
    // missing methods and refuse rather than crashing on .idFromName().
    installBigRepoFetchMock();
    const result = await handleAudit(makeRequest({
      flags: { analyze: 'true', lens: 'security', depth: 'deep' },
      transport: 'telegram',
      chatId: 12345,
      context: { telegramToken: 'tg-token' },
      env: {
        GITHUB_TOKEN: 'tok', OPENROUTER_API_KEY: 'k',
        TASK_PROCESSOR: {} as unknown, // hollow (post-JSON binding)
      } as unknown as MoltbotEnv,
    }));
    // No DO available → refuse with clear message; never throws.
    expect(result.kind).toBe('error');
    expect(result.body).toMatch(/too large for inline/i);
  });
});

// ---------------------------------------------------------------------------
// Slice 3 follow-ups (GPT review): deterministic key, status check, DO env
// ---------------------------------------------------------------------------

describe('audit_do_key — deterministic DO identity', () => {
  function planFor(overrides: Partial<{ owner: string; repo: string; sha: string; lenses: ('security'|'deps'|'types'|'tests'|'deadcode'|'perf')[]; depth: 'quick'|'standard'|'deep' }> = {}) {
    return {
      profile: {
        owner: overrides.owner ?? 'octocat',
        repo: overrides.repo ?? 'demo',
        sha: overrides.sha ?? 'a'.repeat(40),
        defaultBranch: 'main',
        meta: { private: false, archived: false, sizeKb: 0, primaryLanguage: 'TypeScript', languages: {}, description: null },
        tree: [], manifests: [], codeScanningAlerts: [],
        codeScanningAlertsTruncated: false, treeTruncated: false,
        profileHash: 'h', collectedAt: 'now',
      },
      lenses: overrides.lenses ?? (['security'] as const),
      depth: overrides.depth ?? 'quick',
      selections: { security: [], deps: [], types: [], tests: [], deadcode: [], perf: [] },
      estimate: { llmCalls: 0, inputTokens: 0, costUsd: 0 },
      notes: [],
    } as Parameters<typeof audit_do_key>[1];
  }

  it('produces the same key for the same audit on rerun', () => {
    const k1 = audit_do_key('user-1', planFor({ lenses: ['security', 'deps'] }));
    const k2 = audit_do_key('user-1', planFor({ lenses: ['security', 'deps'] }));
    expect(k1).toBe(k2);
  });

  it('is order-stable on the lens list', () => {
    const k1 = audit_do_key('u', planFor({ lenses: ['security', 'deps', 'types'] }));
    const k2 = audit_do_key('u', planFor({ lenses: ['types', 'security', 'deps'] }));
    expect(k1).toBe(k2);
  });

  it('produces different keys when the SHA differs (commit-pinned)', () => {
    const k1 = audit_do_key('u', planFor({ sha: 'a'.repeat(40) }));
    const k2 = audit_do_key('u', planFor({ sha: 'b'.repeat(40) }));
    expect(k1).not.toBe(k2);
  });

  it('produces different keys for different users (isolation)', () => {
    expect(audit_do_key('u1', planFor())).not.toBe(audit_do_key('u2', planFor()));
  });

  it('produces different keys for different depths', () => {
    expect(audit_do_key('u', planFor({ depth: 'quick' })))
      .not.toBe(audit_do_key('u', planFor({ depth: 'deep' })));
  });
});

describe('--analyze: DO dispatch status check (slice-3 hardening)', () => {
  /** Reuse the same big-tree fixture as the slice-3 dispatch tests. */
  function installBigRepoFetchMock() {
    const tree = Array.from({ length: 60 }, (_, i) => ({
      path: `src/auth/h${i}.ts`, type: 'blob' as const, sha: `s${i}`, size: 100,
    }));
    installFetchMock([
      { match: (u) => /\/repos\/[^/]+\/[^/]+$/.test(u), body: { default_branch: 'main', private: false, archived: false, size: 1, language: 'TypeScript', description: null } },
      { match: (u) => /\/languages$/.test(u), body: {} },
      { match: (u) => /\/git\/refs\/heads\//.test(u), body: { ref: 'refs/heads/main', object: { sha: 'a'.repeat(40) } } },
      { match: (u) => /\/git\/trees\//.test(u), body: { truncated: false, tree } },
      { match: (u) => u.includes('/code-scanning/alerts'), status: 404, body: {} },
    ]);
  }

  it('returns an error when the DO responds with a non-2xx status', async () => {
    installBigRepoFetchMock();
    const stub = {
      fetch: vi.fn().mockResolvedValue(new Response('overloaded', { status: 503 })),
    };
    const taskProcessor = {
      idFromName: vi.fn().mockReturnValue('do-id'),
      get: vi.fn().mockReturnValue(stub),
    };

    const result = await handleAudit(makeRequest({
      flags: { analyze: 'true', lens: 'security', depth: 'deep' },
      transport: 'telegram',
      chatId: 12345,
      context: { telegramToken: 'tg-token' },
      env: {
        GITHUB_TOKEN: 'tok', OPENROUTER_API_KEY: 'k',
        TASK_PROCESSOR: taskProcessor,
      } as unknown as MoltbotEnv,
    }));

    // Critical: do NOT report "Audit started" when the DO refused.
    expect(result.kind).toBe('error');
    expect(result.body).toMatch(/dispatch failed/i);
    expect(result.body).toContain('503');
    expect(result.body).toContain('overloaded'); // body excerpt is surfaced
  });

  it('uses a deterministic DO id (audit_do_key) for the dispatch', async () => {
    installBigRepoFetchMock();
    const stub = {
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'started' }))),
    };
    const taskProcessor = {
      idFromName: vi.fn().mockReturnValue('do-id'),
      get: vi.fn().mockReturnValue(stub),
    };

    await handleAudit(makeRequest({
      flags: { analyze: 'true', lens: 'security', depth: 'deep' },
      transport: 'telegram',
      chatId: 12345,
      userId: 'user-42',
      context: { telegramToken: 'tg-token' },
      env: {
        GITHUB_TOKEN: 'tok', OPENROUTER_API_KEY: 'k',
        TASK_PROCESSOR: taskProcessor,
      } as unknown as MoltbotEnv,
    }));

    // The id should embed (user, repo, sha, lens, depth) — NOT a UUID.
    const passedId = taskProcessor.idFromName.mock.calls[0][0];
    expect(passedId).toContain('audit:user-42:octocat/hello-world');
    expect(passedId).toContain('security');
    expect(passedId).toContain('deep');
    // Not a random UUID — repeated calls produce the SAME id.
    taskProcessor.idFromName.mockClear();
    await handleAudit(makeRequest({
      flags: { analyze: 'true', lens: 'security', depth: 'deep' },
      transport: 'telegram',
      chatId: 12345,
      userId: 'user-42',
      context: { telegramToken: 'tg-token' },
      env: {
        GITHUB_TOKEN: 'tok', OPENROUTER_API_KEY: 'k',
        TASK_PROCESSOR: taskProcessor,
      } as unknown as MoltbotEnv,
    }));
    const passedId2 = taskProcessor.idFromName.mock.calls[0][0];
    expect(passedId2).toBe(passedId);
  });
});

// ---------------------------------------------------------------------------
// Slice 4a — /audit export <runId> + AuditRun persistence
// ---------------------------------------------------------------------------

describe('command-map: /audit subcommands', () => {
  it('parses /audit export <runId> as subcommand=export with text=runId', () => {
    const r = parseCommandMessage('/audit export abc-def-123');
    expect(r).not.toBeNull();
    expect(r!.mapping.skillId).toBe('audit');
    expect(r!.subcommand).toBe('export');
    expect(r!.text).toBe('abc-def-123');
  });

  it('parses /audit run <repo> as subcommand=run', () => {
    const r = parseCommandMessage('/audit run octocat/demo');
    expect(r!.subcommand).toBe('run');
    expect(r!.text).toBe('octocat/demo');
  });

  it('falls back to subcommand=plan when no recognized subcommand', () => {
    const r = parseCommandMessage('/audit octocat/demo');
    expect(r!.subcommand).toBe('plan');
    expect(r!.text).toBe('octocat/demo');
  });
});

describe('--analyze: persists AuditRun to NEXUS_KV after completion (DO path)', () => {
  it('writes the run when running with context.runningInDO=true (oversize → DO → cacheAuditRun)', async () => {
    // Regression for the slice-3 risk GPT flagged: oversize audits dispatch
    // to the DO; the DO calls runFullAudit with runningInDO=true; that path
    // MUST still call cacheAuditRun so /audit export can later retrieve it.
    // We exercise the DO's executed code path by passing runningInDO=true
    // directly into handleAudit (the DO's processSkillTask sets the same
    // flag when it invokes runSkill, contract tested in
    // build-skill-env.test.ts).
    const tree = Array.from({ length: 30 }, (_, i) => ({
      path: `src/auth/h${i}.ts`, type: 'blob' as const, sha: `s${i}`, size: 100,
    }));
    installFetchMock([
      { match: (u) => /\/repos\/[^/]+\/[^/]+$/.test(u), body: { default_branch: 'main', private: false, archived: false, size: 1, language: 'TypeScript', description: null } },
      { match: (u) => /\/languages$/.test(u), body: {} },
      { match: (u) => /\/git\/refs\/heads\//.test(u), body: { ref: 'refs/heads/main', object: { sha: 'a'.repeat(40) } } },
      { match: (u) => /\/git\/trees\//.test(u), body: { truncated: false, tree } },
      // Per-file content fetches return 404 — the Analyst will short-circuit
      // (no snippets) but the run STILL gets persisted with its empty findings.
      { match: (u) => u.includes('/contents/'), status: 404, body: {} },
      { match: (u) => u.includes('/code-scanning/alerts'), status: 404, body: {} },
    ]);
    mockLLM.mockResolvedValue({ text: JSON.stringify({ findings: [] }) });

    const kvStore = new Map<string, string>();
    const kv = {
      get: vi.fn(async (key: string, type?: string) => {
        const v = kvStore.get(key);
        if (v === undefined) return null;
        return type === 'json' ? JSON.parse(v) : v;
      }),
      put: vi.fn(async (key: string, value: string) => { kvStore.set(key, value); }),
    } as unknown as KVNamespace;

    // Simulate the DO context: runningInDO=true bypasses the inline-budget
    // guard AND the dispatcher. depth=deep would ordinarily refuse inline.
    const result = await handleAudit(makeRequest({
      flags: { analyze: 'true', lens: 'security', depth: 'deep' },
      userId: 'user-99',
      transport: 'telegram',
      chatId: 12345,
      context: { telegramToken: 'tg', runningInDO: true },
      env: {
        GITHUB_TOKEN: 'tok', OPENROUTER_API_KEY: 'k',
        NEXUS_KV: kv,
      } as unknown as MoltbotEnv,
    }));
    expect(result.kind).toBe('audit_run');
    const run = result.data as AuditRun;

    // The DO-side run was persisted under the same user-scoped key shape
    // as the inline path — round-trip via /audit export will now succeed.
    const expectedKey = `audit:run:user-99:${run.runId}`;
    expect(kv.put).toHaveBeenCalledWith(
      expectedKey,
      expect.any(String),
      expect.objectContaining({ expirationTtl: expect.any(Number) }),
    );
    const persisted = JSON.parse(kvStore.get(expectedKey)!);
    expect(persisted.runId).toBe(run.runId);
  });

  it('writes the run under audit:run:{userId}:{runId} so /audit export can find it', async () => {
    const tree = [
      { path: 'package.json', type: 'blob', sha: 'm0', size: 30 },
      { path: 'src/auth.ts', type: 'blob', sha: 'a1', size: 30 },
    ];
    installFetchMock([
      { match: (u) => /\/repos\/[^/]+\/[^/]+$/.test(u), body: { default_branch: 'main', private: false, archived: false, size: 1, language: 'TypeScript', description: null } },
      { match: (u) => /\/languages$/.test(u), body: {} },
      { match: (u) => /\/git\/refs\/heads\//.test(u), body: { ref: 'refs/heads/main', object: { sha: 'a'.repeat(40) } } },
      { match: (u) => /\/git\/trees\//.test(u), body: { truncated: false, tree } },
      { match: (u) => u.includes('/contents/package.json'), body: { encoding: 'base64', content: btoa('{"name":"x"}'), sha: 'm0', size: 30 } },
      { match: (u) => u.includes('/contents/src/auth.ts'), body: { encoding: 'base64', content: btoa('export const x = 1;'), sha: 'a1', size: 30 } },
      { match: (u) => u.includes('/code-scanning/alerts'), status: 404, body: {} },
    ]);

    mockLLM.mockResolvedValue({
      text: JSON.stringify({
        findings: [{
          lens: 'security', severity: 'high', confidence: 0.75,
          symptom: 'Token leak',
          rootCause: 'No secret scan',
          correctiveAction: 'Rotate + env var',
          preventiveAction: { kind: 'ci', detail: 'Add gitleaks step' },
          evidence: [{ path: 'src/auth.ts', lines: '1-1', snippet: 'export' }],
        }],
      }),
    });

    const kvStore = new Map<string, string>();
    const kv = {
      get: vi.fn(async (key: string, type?: string) => {
        const v = kvStore.get(key);
        if (v === undefined) return null;
        if (type === 'json') return JSON.parse(v);
        return v;
      }),
      put: vi.fn(async (key: string, value: string) => { kvStore.set(key, value); }),
    } as unknown as KVNamespace;

    const result = await handleAudit(makeRequest({
      flags: { analyze: 'true', lens: 'security' },
      userId: 'user-42',
      env: {
        GITHUB_TOKEN: 'tok', OPENROUTER_API_KEY: 'k',
        NEXUS_KV: kv,
      } as unknown as MoltbotEnv,
    }));
    expect(result.kind).toBe('audit_run');
    const run = result.data as AuditRun;

    // Persistence: KV.put was called with the user-scoped key.
    const expectedKey = `audit:run:user-42:${run.runId}`;
    expect(kv.put).toHaveBeenCalledWith(
      expectedKey,
      expect.any(String),
      expect.objectContaining({ expirationTtl: expect.any(Number) }),
    );
    // The persisted value JSON-roundtrips back to the same shape.
    const persisted = JSON.parse(kvStore.get(expectedKey)!);
    expect(persisted.runId).toBe(run.runId);
    expect(persisted.findings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Slice 4b — inline keyboard shape (Fix / Suppress / Full report)
// ---------------------------------------------------------------------------

describe('audit_run renderer: inline keyboard', () => {
  function runWithFindings(n: number): AuditRun {
    return {
      runId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      repo: { owner: 'octocat', name: 'demo', sha: 'a'.repeat(40) },
      lenses: ['security'],
      depth: 'quick',
      findings: Array.from({ length: n }, (_, i) => ({
        id: `security-fhash${i}`,
        lens: 'security',
        severity: 'high',
        confidence: 0.75,
        evidence: [{ path: 'src/x.ts', source: 'llm' as const }],
        symptom: `s${i}`, rootCause: 'r', correctiveAction: 'c',
        preventiveAction: { kind: 'lint', detail: 'rule body' },
      })),
      telemetry: { durationMs: 1, llmCalls: 1, tokensIn: 1, tokensOut: 1, costUsd: 0, githubApiCalls: 1 },
    };
  }

  it('emits one Fix/Suppress row per top-3 finding + a final Full report row', async () => {
    const { renderForTelegram } = await import('../renderers/telegram');
    const chunks = renderForTelegram({
      skillId: 'audit', kind: 'audit_run',
      body: 'short body',
      data: runWithFindings(5), // top-3 capped — test verifies the cap holds
      telemetry: { durationMs: 1, model: 'flash', llmCalls: 1, toolCalls: 1 },
    });
    const last = chunks.at(-1)!;
    const rows = last.replyMarkup!;
    // 3 finding rows + 1 export row = 4 total
    expect(rows).toHaveLength(4);
    // Per-finding rows: two buttons each (Fix + Suppress)
    for (let i = 0; i < 3; i++) {
      expect(rows[i]).toHaveLength(2);
      // "Prepare fix" not "Fix" — button preps a confirmation dialog, no
      // immediate orchestra dispatch. Slice-4d safety fix.
      expect(rows[i][0].text).toMatch(/🔧 Prepare fix/);
      expect(rows[i][1].text).toMatch(/🔇 Suppress/);
      expect(rows[i][0].callback_data).toBe(`audit:fix:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee:security-fhash${i}`);
      expect(rows[i][1].callback_data).toBe(`audit:sup:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee:security-fhash${i}`);
    }
    // Final Full report row
    expect(rows[3]).toHaveLength(1);
    expect(rows[3][0].text).toMatch(/📄 Full report/);
    expect(rows[3][0].callback_data).toBe('audit:export:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  });

  it('omits the keyboard when there are no findings', async () => {
    const { renderForTelegram } = await import('../renderers/telegram');
    const chunks = renderForTelegram({
      skillId: 'audit', kind: 'audit_run',
      body: 'no defects', data: runWithFindings(0),
      telemetry: { durationMs: 1, model: 'flash', llmCalls: 1, toolCalls: 1 },
    });
    expect(chunks[0].replyMarkup).toBeUndefined();
  });

  it('keeps every callback_data within Telegram\'s 64-byte hard cap', async () => {
    const { renderForTelegram } = await import('../renderers/telegram');
    const chunks = renderForTelegram({
      skillId: 'audit', kind: 'audit_run',
      body: 'x', data: runWithFindings(3),
      telemetry: { durationMs: 1, model: 'flash', llmCalls: 1, toolCalls: 1 },
    });
    const rows = chunks[0].replyMarkup!;
    for (const row of rows) {
      for (const btn of row) {
        // Telegram rejects callback_data > 64 bytes. We assert the actual
        // UTF-8 byte length (TextEncoder), not string.length.
        const bytes = new TextEncoder().encode(btn.callback_data!).length;
        expect(bytes).toBeLessThanOrEqual(64);
      }
    }
  });

  it('omits keyboard on audit_plan results (only audit_run gets controls)', async () => {
    const { renderForTelegram } = await import('../renderers/telegram');
    const chunks = renderForTelegram({
      skillId: 'audit', kind: 'audit_plan',
      body: 'plan body', data: { foo: 'bar' },
      telemetry: { durationMs: 1, model: 'none', llmCalls: 0, toolCalls: 0 },
    });
    expect(chunks[0].replyMarkup).toBeUndefined();
  });
});

describe('/audit export', () => {
  function kvWithRun(userId: string, run: AuditRun) {
    const store = new Map<string, string>();
    store.set(`audit:run:${userId}:${run.runId}`, JSON.stringify(run));
    return {
      get: vi.fn(async (key: string, type?: string) => {
        const v = store.get(key);
        if (v === undefined) return null;
        return type === 'json' ? JSON.parse(v) : v;
      }),
      put: vi.fn(),
    } as unknown as KVNamespace;
  }

  function makeRun(overrides: Partial<AuditRun> = {}): AuditRun {
    return {
      runId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      repo: { owner: 'octocat', name: 'demo', sha: 'a'.repeat(40) },
      lenses: ['security'],
      depth: 'quick',
      findings: [
        {
          id: 'security-abc',
          lens: 'security',
          severity: 'high',
          confidence: 0.75,
          evidence: [{ path: 'src/auth.ts', lines: '10-15', source: 'llm', snippet: 'const TOKEN = …', sha: 'a1' }],
          symptom: 'Hardcoded API token',
          rootCause: 'Missing pre-commit secret scan',
          correctiveAction: 'Rotate token; move to env var',
          preventiveAction: {
            kind: 'ci',
            detail: 'name: secret-scan\non: [push]\njobs:\n  scan:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: gitleaks/gitleaks-action@v2',
          },
        },
      ],
      telemetry: { durationMs: 1234, llmCalls: 1, tokensIn: 800, tokensOut: 200, costUsd: 0.0007, githubApiCalls: 7 },
      ...overrides,
    };
  }

  it('returns a full report from KV when given a valid runId', async () => {
    const run = makeRun();
    const kv = kvWithRun('user-1', run);
    const result = await handleAudit(makeRequest({
      subcommand: 'export',
      text: run.runId,
      userId: 'user-1',
      env: { OPENROUTER_API_KEY: 'k', NEXUS_KV: kv } as unknown as MoltbotEnv,
    }));
    expect(result.kind).toBe('audit_run');
    // Full preventive artifact present (including the multi-line workflow yaml).
    expect(result.body).toContain('gitleaks/gitleaks-action@v2');
    expect(result.body).toContain('name: secret-scan');
    // Run id is surfaced.
    expect(result.body).toContain(run.runId);
  });

  it('rejects empty runId with usage hint', async () => {
    const result = await handleAudit(makeRequest({
      subcommand: 'export',
      text: '',
      userId: 'user-1',
      env: { NEXUS_KV: kvWithRun('user-1', makeRun()) } as unknown as MoltbotEnv,
    }));
    expect(result.kind).toBe('error');
    expect(result.body).toMatch(/usage/i);
  });

  it('rejects malformed runId without hitting KV', async () => {
    const kv = kvWithRun('user-1', makeRun());
    const result = await handleAudit(makeRequest({
      subcommand: 'export',
      text: 'not a real id with spaces',
      userId: 'user-1',
      env: { NEXUS_KV: kv } as unknown as MoltbotEnv,
    }));
    expect(result.kind).toBe('error');
    expect(result.body).toMatch(/not a valid run id/i);
    expect(kv.get).not.toHaveBeenCalled();
  });

  it.each([
    ['empty hex run', 'deadbeef'],                                            // too short, no dashes
    ['all dashes', '--------'],                                               // matched the old loose regex
    ['hex with spurious dashes', 'abc-----def'],                              // loose regex would accept
    ['UUID with bad version digit', 'aaaaaaaa-bbbb-cccc-8ddd-eeeeeeeeeeee'],  // v=c, must be 1-5
    ['UUID with bad variant digit', 'aaaaaaaa-bbbb-4ccc-cddd-eeeeeeeeeeee'],  // var=c, must be 8-b
    ['Wrong group lengths',         'aaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'],   // 7 chars in first group
  ])('rejects %s as not a valid runId (strict UUID)', async (_label, badId) => {
    const kv = kvWithRun('user-1', makeRun());
    const result = await handleAudit(makeRequest({
      subcommand: 'export',
      text: badId,
      userId: 'user-1',
      env: { NEXUS_KV: kv } as unknown as MoltbotEnv,
    }));
    expect(result.kind).toBe('error');
    expect(result.body).toMatch(/not a valid run id/i);
    expect(kv.get).not.toHaveBeenCalled();
  });

  it('accepts a real crypto.randomUUID() shape (sanity)', async () => {
    // The v4 UUIDs the runtime produces MUST pass — otherwise we'd reject
    // every real run id we ever stored.
    const realUuid = crypto.randomUUID();
    const run = makeRun({ runId: realUuid });
    const kv = kvWithRun('user-1', run);
    const result = await handleAudit(makeRequest({
      subcommand: 'export',
      text: realUuid,
      userId: 'user-1',
      env: { NEXUS_KV: kv } as unknown as MoltbotEnv,
    }));
    expect(result.kind).toBe('audit_run');
  });

  it('returns clear error when the run is not found (or expired)', async () => {
    const kv = kvWithRun('user-1', makeRun()); // has run for user-1, NOT user-2
    const result = await handleAudit(makeRequest({
      subcommand: 'export',
      text: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      userId: 'user-2', // different user → user-scoped key won't match
      env: { NEXUS_KV: kv } as unknown as MoltbotEnv,
    }));
    expect(result.kind).toBe('error');
    expect(result.body).toMatch(/no audit run found/i);
    expect(result.body).toMatch(/7 days/i);
  });

  it('shows suppressed findings in a separate section (export transparency)', async () => {
    // Closes GPT slice-4c review finding 2. The persisted run keeps
    // suppressed findings with `suppressed: true`; the export view
    // surfaces them in a distinct "Suppressed findings (...)" section.
    const run = makeRun({
      findings: [
        {
          id: 'security-active1', lens: 'security', severity: 'high', confidence: 0.75,
          evidence: [{ path: 'src/auth.ts', source: 'llm' }],
          symptom: 'Active defect',
          rootCause: 'r', correctiveAction: 'c',
          preventiveAction: { kind: 'lint', detail: 'rule' },
        },
        {
          id: 'security-supp1', lens: 'security', severity: 'medium', confidence: 0.75,
          evidence: [{ path: 'src/auth.ts', source: 'llm' }],
          symptom: 'Previously suppressed defect',
          rootCause: 'r', correctiveAction: 'c',
          preventiveAction: { kind: 'lint', detail: 'rule' },
          suppressed: true,
        },
      ],
    });
    const kv = kvWithRun('user-1', run);
    const result = await handleAudit(makeRequest({
      subcommand: 'export', text: run.runId, userId: 'user-1',
      env: { NEXUS_KV: kv } as unknown as MoltbotEnv,
    }));
    expect(result.kind).toBe('audit_run');
    expect(result.body).toContain('Findings (1):'); // active count, not all
    expect(result.body).toContain('Active defect');
    expect(result.body).toMatch(/Suppressed findings \(1\)/);
    expect(result.body).toContain('Previously suppressed defect');
    // The id of the suppressed finding is shown so the user can /audit
    // unsuppress it directly from the export.
    expect(result.body).toContain('security-supp1');
  });

  it('returns JSON dump when --format json is set', async () => {
    const run = makeRun();
    const kv = kvWithRun('user-1', run);
    const result = await handleAudit(makeRequest({
      subcommand: 'export',
      text: run.runId,
      userId: 'user-1',
      flags: { format: 'json' },
      env: { NEXUS_KV: kv } as unknown as MoltbotEnv,
    }));
    expect(result.kind).toBe('text');
    // Body is parseable JSON with the same data.
    const parsed = JSON.parse(result.body);
    expect(parsed.runId).toBe(run.runId);
    expect(parsed.findings[0].id).toBe('security-abc');
  });

  it('attaches the inline keyboard ONLY to the last chunk (not duplicated)', async () => {
    // Multi-chunk export with findings → keyboard appears once, on the
    // final chunk. Telegram shows the keyboard with the message it's
    // attached to; duplicating across chunks would render a confusing
    // ladder of identical button rows.
    const run = makeRun({
      findings: Array.from({ length: 5 }, (_, i) => ({
        id: `security-fhash${i}`,
        lens: 'security' as const,
        severity: 'high' as const,
        confidence: 0.75 as const,
        evidence: [{ path: 'src/auth.ts', lines: '1-1', source: 'llm' as const, snippet: 'tok' }],
        symptom: `Defect ${i}`,
        rootCause: 'Cause',
        correctiveAction: 'Fix',
        preventiveAction: { kind: 'ci' as const, detail: 'workflow yaml '.repeat(200) },
      })),
    });
    const kv = kvWithRun('user-1', run);
    const result = await handleAudit(makeRequest({
      subcommand: 'export',
      text: run.runId,
      userId: 'user-1',
      env: { NEXUS_KV: kv } as unknown as MoltbotEnv,
    }));
    expect(result.body.length).toBeGreaterThan(4096);

    const { renderForTelegram } = await import('../renderers/telegram');
    const chunks = renderForTelegram(result);
    expect(chunks.length).toBeGreaterThan(1);
    // Only the LAST chunk carries the keyboard.
    for (let i = 0; i < chunks.length - 1; i++) {
      expect(chunks[i].replyMarkup).toBeUndefined();
    }
    expect(chunks.at(-1)!.replyMarkup).toBeDefined();
  });

  it('renders into Telegram-safe chunks when the export body exceeds 4 KiB', async () => {
    // Build a large run: 12 findings, each with a multi-line preventive
    // artifact, evidence snippets, and prose. The serialized body will
    // exceed Telegram's 4096-char limit and MUST be chunked rather than
    // sent as one oversize message (which Telegram would reject).
    const run = makeRun({
      findings: Array.from({ length: 12 }, (_, i) => ({
        id: `security-${i}`,
        lens: 'security' as const,
        severity: 'high' as const,
        confidence: 0.75 as const,
        evidence: [{
          path: 'src/auth.ts',
          lines: `${i * 10}-${i * 10 + 5}`,
          source: 'llm' as const,
          snippet: `const TOKEN_${i} = 'sk_...';\n// padding line ${i}`.repeat(2),
        }],
        symptom: `Hardcoded secret variant ${i}`,
        rootCause: `Repeated pattern: secret literal committed in handler ${i}; CI lacks pre-commit secret scan`,
        correctiveAction: `Rotate TOKEN_${i}; move to env var; redeploy`,
        preventiveAction: {
          kind: 'ci' as const,
          detail: [
            `name: secret-scan-${i}`,
            `on: [push, pull_request]`,
            `jobs:`,
            `  scan:`,
            `    runs-on: ubuntu-latest`,
            `    steps:`,
            `      - uses: actions/checkout@v4`,
            `      - uses: gitleaks/gitleaks-action@v2`,
            `        with:`,
            `          config-path: .gitleaks.toml`,
          ].join('\n'),
        },
      })),
    });
    const kv = kvWithRun('user-1', run);

    const result = await handleAudit(makeRequest({
      subcommand: 'export',
      text: run.runId,
      userId: 'user-1',
      env: { NEXUS_KV: kv } as unknown as MoltbotEnv,
    }));
    expect(result.kind).toBe('audit_run');
    // Sanity: the body really is oversize (otherwise this isn't testing
    // what we think it is).
    expect(result.body.length).toBeGreaterThan(4096);

    // Run the body through the actual telegram renderer used in production.
    const { renderForTelegram } = await import('../renderers/telegram');
    const chunks = renderForTelegram(result);

    // The renderer MUST produce multiple chunks, each within Telegram's
    // 4096-char limit. (We assert <= 4096 with a small safety margin
    // since the renderer reserves space for tag-repair markup.)
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(4096);
    }
    // Every chunk should still parse/render the same parseMode (HTML).
    for (const c of chunks) expect(c.parseMode).toBe('HTML');
  });
});

// ---------------------------------------------------------------------------
// Slice 4c — per-repo suppression list
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Slice 4d — Orchestra hand-off (buildOrchestraTask + resolveFix + /audit fix)
// ---------------------------------------------------------------------------

describe('buildOrchestraTask', () => {
  function fixture(overrides: Partial<AuditFinding> = {}): AuditFinding {
    return {
      id: 'security-abc',
      lens: 'security', severity: 'high', confidence: 0.75,
      evidence: [
        { path: 'src/auth.ts', lines: '10-12', source: 'llm',
          snippet: "const TOKEN = 'sk_live_…';\nreturn TOKEN;", sha: 'a1' },
      ],
      symptom: 'Hardcoded API token in login()',
      rootCause: 'No pre-commit secret scan; TOKEN literal committed',
      correctiveAction: 'Move TOKEN to env var; rotate the leaked secret',
      preventiveAction: {
        kind: 'ci',
        detail: 'name: secret-scan\non: [push]\njobs:\n  scan:\n    runs-on: ubuntu-latest',
      },
      ...overrides,
    };
  }
  function runFixture(): AuditRun {
    return {
      runId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      repo: { owner: 'octocat', name: 'demo', sha: 'a'.repeat(40) },
      lenses: ['security'], depth: 'quick',
      findings: [fixture()],
      telemetry: { durationMs: 1, llmCalls: 1, tokensIn: 1, tokensOut: 1, costUsd: 0, githubApiCalls: 1 },
    };
  }

  it('produces a self-contained orchestra task with repo coords + corrective + preventive + evidence', () => {
    const text = buildOrchestraTask(runFixture(), fixture());
    expect(text).toContain('Fix audit finding in octocat/demo@aaaaaaa');
    expect(text).toContain('Severity: high');
    expect(text).toContain('Lens: security');
    expect(text).toContain('Symptom: Hardcoded API token in login()');
    expect(text).toContain('Root cause:');
    expect(text).toContain('Required corrective action:');
    expect(text).toContain('Move TOKEN to env var');
    expect(text).toContain('Preventive control to add (ci):');
    expect(text).toContain('name: secret-scan'); // preventive artifact body preserved
    expect(text).toContain('runs-on: ubuntu-latest'); // multi-line preserved
    expect(text).toContain('src/auth.ts:10-12');
    expect(text).toContain('aaaaaaa'); // evidence sha (short)
    // Run + finding id are cited so a follow-up audit can mark this fixed.
    expect(text).toContain('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    expect(text).toContain('security-abc');
  });

  it('is deterministic for the same inputs (reproducibility)', () => {
    const a = buildOrchestraTask(runFixture(), fixture());
    const b = buildOrchestraTask(runFixture(), fixture());
    expect(a).toBe(b);
  });

  it('appends orchestraPatchBrief when present', () => {
    const f = fixture({ orchestraPatchBrief: 'Touch only src/auth.ts; do not refactor neighboring files.' });
    const text = buildOrchestraTask(runFixture(), f);
    expect(text).toContain('Additional context:');
    expect(text).toContain('Touch only src/auth.ts');
  });

  it('truncates very long evidence-snippet first lines (keeps the prompt tight)', () => {
    const f = fixture({
      evidence: [{ path: 'src/x.ts', source: 'llm', snippet: 'x'.repeat(500) }],
    });
    const text = buildOrchestraTask(runFixture(), f);
    // Snippet line is bounded — we don't dump the whole 500-char run into the
    // orchestra prompt.
    const lines = text.split('\n');
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(220);
    }
  });

  it('emits a Constraints block telling orchestra to branch+PR, not refactor, cite ids, etc.', () => {
    // Closes GPT slice-4d review finding 3. The audit hand-off must
    // explicitly bound orchestra's behavior — without these constraints
    // the upstream LLM may helpfully refactor neighboring files or push
    // straight to main.
    const text = buildOrchestraTask(runFixture(), fixture());
    expect(text).toContain('Constraints:');
    expect(text).toMatch(/branch and open a PR/i);
    expect(text).toMatch(/never push directly to main/i);
    expect(text).toMatch(/minimal and scoped/i);
    expect(text).toMatch(/Do not refactor unrelated code/i);
    expect(text).toMatch(/preventive action/i);
    expect(text).toMatch(/Cite this audit run id and finding id in the PR/i);
    expect(text).toMatch(/STOP and reply/i);
  });
});

describe('buildFixSummary (Prepare → Confirm UX)', () => {
  function f(): AuditFinding {
    return {
      id: 'security-abc', lens: 'security', severity: 'high', confidence: 0.75,
      evidence: [{ path: 'src/auth.ts', source: 'llm' }],
      symptom: 'Hardcoded API token in login()',
      rootCause: 'r', correctiveAction: 'Move TOKEN to env var',
      preventiveAction: { kind: 'ci', detail: 'gitleaks step\nplus more lines' },
    };
  }
  function r(): AuditRun {
    return {
      runId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      repo: { owner: 'octocat', name: 'demo', sha: 'a'.repeat(40) },
      lenses: ['security'], depth: 'quick', findings: [f()],
      telemetry: { durationMs: 1, llmCalls: 1, tokensIn: 1, tokensOut: 1, costUsd: 0, githubApiCalls: 1 },
    };
  }

  it('shows symptom + corrective + preventive kind+first-line + confirm/cancel hint', () => {
    const text = buildFixSummary(r(), f());
    expect(text).toContain('Hardcoded API token in login()');
    expect(text).toContain('Move TOKEN to env var');
    expect(text).toContain('[ci]');
    expect(text).toContain('gitleaks step');
    expect(text).toMatch(/Dispatch fix/);
    expect(text).toMatch(/Cancel/);
    // The summary is INFO only — does not include the full orchestra task
    // body or the Constraints block (those land at orchestra on confirm).
    expect(text).not.toMatch(/Constraints:/);
  });

  it('escapes HTML special characters in user-controlled fields', () => {
    const finding = { ...f(), symptom: 'XSS via <script>alert(1)</script>' };
    const run = { ...r(), findings: [finding], repo: { owner: '<owner>', name: '<repo>', sha: 'a'.repeat(40) } };
    const text = buildFixSummary(run, finding);
    expect(text).not.toContain('<script>'); // raw < must not appear
    expect(text).toContain('&lt;script&gt;');
    expect(text).toContain('&lt;owner&gt;');
  });
});

describe('audit inline keyboard: prepare→confirm callback shape', () => {
  it('keeps audit:go and audit:no callback_data within the 64-byte cap (token-based)', () => {
    // Slice-4d follow-up: confirm/cancel use a 16-hex-char draft token
    // instead of <runId>:<findingId>. Keeps callback_data ~24 bytes total
    // and frees headroom for longer finding-ids if the validator schema
    // grows. The fix prepare path still uses runId+findingId because the
    // draft doesn't exist yet at that point.
    const runId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'; // 36 chars
    const findingId = 'security-zzzzzzz';                  // 16 chars (MVP worst case)
    const token = '0123456789abcdef';                      // 16 hex chars
    // Prepare-shape verbs still take runId+findingId.
    for (const verb of ['fix', 'sup']) {
      const data = `audit:${verb}:${runId}:${findingId}`;
      expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
    }
    // Confirm/cancel verbs take only the token now.
    for (const verb of ['go', 'no']) {
      const data = `audit:${verb}:${token}`;
      expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
    }
  });
});

describe('resolveFix', () => {
  function makeKVWith(run: AuditRun, userId = 'user-1') {
    const store = new Map<string, string>();
    store.set(`audit:run:${userId}:${run.runId}`, JSON.stringify(run));
    return {
      get: vi.fn(async (key: string, type?: string) => {
        const v = store.get(key);
        if (v === undefined) return null;
        return type === 'json' ? JSON.parse(v) : v;
      }),
      put: vi.fn(),
    } as unknown as KVNamespace;
  }
  const run: AuditRun = {
    runId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    repo: { owner: 'octocat', name: 'demo', sha: 'a'.repeat(40) },
    lenses: ['security'], depth: 'quick',
    findings: [{
      id: 'security-abc',
      lens: 'security', severity: 'high', confidence: 0.75,
      evidence: [{ path: 'src/auth.ts', source: 'llm' }],
      symptom: 's', rootCause: 'r', correctiveAction: 'c',
      preventiveAction: { kind: 'lint', detail: 'rule' },
    }],
    telemetry: { durationMs: 1, llmCalls: 1, tokensIn: 1, tokensOut: 1, costUsd: 0, githubApiCalls: 1 },
  };

  it('returns ok:true with run+finding+taskText for a valid lookup', async () => {
    const kv = makeKVWith(run);
    const r = await resolveFix(kv, 'user-1', run.runId, 'security-abc');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.run.runId).toBe(run.runId);
    expect(r.finding.id).toBe('security-abc');
    expect(r.taskText).toContain('octocat/demo');
    expect(r.taskText).toContain('security-abc');
  });

  it('returns ok:false on malformed runId', async () => {
    const kv = makeKVWith(run);
    const r = await resolveFix(kv, 'user-1', 'not-a-uuid', 'security-abc');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/not a valid run id/i);
    expect(kv.get).not.toHaveBeenCalled();
  });

  it('returns ok:false on malformed findingId', async () => {
    const kv = makeKVWith(run);
    const r = await resolveFix(kv, 'user-1', run.runId, 'NOT_A_REAL_FINDING_ID');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/not a valid finding id/i);
    expect(kv.get).not.toHaveBeenCalled();
  });

  it('returns ok:false when the run is not found (cross-user attempt)', async () => {
    const kv = makeKVWith(run, 'user-1');
    const r = await resolveFix(kv, 'user-2', run.runId, 'security-abc');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/no audit run found/i);
  });

  it('returns ok:false when the findingId is not part of the run', async () => {
    const kv = makeKVWith(run);
    const r = await resolveFix(kv, 'user-1', run.runId, 'security-bogus');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/not part of run/i);
  });
});

describe('/audit fix (slash command)', () => {
  function kvWithRun(run: AuditRun) {
    const store = new Map<string, string>();
    store.set(`audit:run:user-1:${run.runId}`, JSON.stringify(run));
    return {
      get: vi.fn(async (key: string, type?: string) => {
        const v = store.get(key);
        if (v === undefined) return null;
        return type === 'json' ? JSON.parse(v) : v;
      }),
      put: vi.fn(),
    } as unknown as KVNamespace;
  }
  const run: AuditRun = {
    runId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    repo: { owner: 'octocat', name: 'demo', sha: 'a'.repeat(40) },
    lenses: ['security'], depth: 'quick',
    findings: [{
      id: 'security-abc',
      lens: 'security', severity: 'high', confidence: 0.75,
      evidence: [{ path: 'src/auth.ts', source: 'llm' }],
      symptom: 'Hardcoded token', rootCause: 'No pre-commit scan',
      correctiveAction: 'Move to env',
      preventiveAction: { kind: 'ci', detail: 'gitleaks step' },
    }],
    telemetry: { durationMs: 1, llmCalls: 1, tokensIn: 1, tokensOut: 1, costUsd: 0, githubApiCalls: 1 },
  };

  it('returns the orchestra dispatch command in the body for manual run', async () => {
    const result = await handleAudit(makeRequest({
      subcommand: 'fix',
      text: `${run.runId} security-abc`,
      userId: 'user-1',
      env: { OPENROUTER_API_KEY: 'k', NEXUS_KV: kvWithRun(run) } as unknown as MoltbotEnv,
    }));
    expect(result.kind).toBe('text');
    expect(result.body).toMatch(/Orchestra task ready/i);
    expect(result.body).toContain('/orch run');
    expect(result.body).toContain('Hardcoded token'); // symptom
    expect(result.body).toContain('Move to env'); // corrective
    expect(result.body).toContain('gitleaks step'); // preventive
    // Structured data exposes the parts a programmatic caller (or the
    // inline-keyboard auto-dispatch path) needs.
    const data = result.data as { runId: string; findingId: string; taskText: string };
    expect(data.runId).toBe(run.runId);
    expect(data.findingId).toBe('security-abc');
    expect(typeof data.taskText).toBe('string');
    expect(data.taskText.length).toBeGreaterThan(50);
  });

  it('rejects empty args with a usage hint', async () => {
    const result = await handleAudit(makeRequest({
      subcommand: 'fix', text: '', userId: 'user-1',
      env: { NEXUS_KV: kvWithRun(run) } as unknown as MoltbotEnv,
    }));
    expect(result.kind).toBe('error');
    expect(result.body).toMatch(/usage/i);
  });

  it('surfaces resolveFix errors as audit error results', async () => {
    const result = await handleAudit(makeRequest({
      subcommand: 'fix',
      text: `${run.runId} security-bogus`,
      userId: 'user-1',
      env: { NEXUS_KV: kvWithRun(run) } as unknown as MoltbotEnv,
    }));
    expect(result.kind).toBe('error');
    expect(result.body).toMatch(/not part of run/i);
  });
});

describe('command-map: /audit fix subcommand', () => {
  it('parses /audit fix <runId> <findingId> as subcommand=fix', () => {
    const r = parseCommandMessage('/audit fix aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee security-abc');
    expect(r!.subcommand).toBe('fix');
    expect(r!.text).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee security-abc');
  });
});

describe('/audit suppress + /audit unsuppress', () => {
  function makeKV() {
    const store = new Map<string, string>();
    const kv = {
      get: vi.fn(async (key: string, type?: string) => {
        const v = store.get(key);
        if (v === undefined) return null;
        return type === 'json' ? JSON.parse(v) : v;
      }),
      put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
      delete: vi.fn(async (key: string) => { store.delete(key); }),
      list: vi.fn(async ({ prefix }: { prefix: string }) => {
        const keys = [...store.keys()]
          .filter(k => k.startsWith(prefix))
          .map(name => ({ name }));
        return { keys, list_complete: true, cursor: undefined };
      }),
    } as unknown as KVNamespace;
    return { kv, store };
  }

  function seedRun(store: Map<string, string>, userId: string) {
    const runId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const findingId = 'security-fhash0';
    const run: AuditRun = {
      runId,
      repo: { owner: 'octocat', name: 'demo', sha: 'a'.repeat(40) },
      lenses: ['security'],
      depth: 'quick',
      findings: [{
        id: findingId,
        lens: 'security', severity: 'high', confidence: 0.75,
        evidence: [{ path: 'src/auth.ts', source: 'llm' }],
        symptom: 's', rootCause: 'r', correctiveAction: 'c',
        preventiveAction: { kind: 'lint', detail: 'rule' },
      }],
      telemetry: { durationMs: 1, llmCalls: 1, tokensIn: 1, tokensOut: 1, costUsd: 0, githubApiCalls: 1 },
    };
    store.set(`audit:run:${userId}:${runId}`, JSON.stringify(run));
    return { runId, findingId, run };
  }

  it('writes the finding-id to the per-repo suppression list and confirms', async () => {
    const { kv, store } = makeKV();
    const { runId, findingId } = seedRun(store, 'user-1');

    const result = await handleAudit(makeRequest({
      subcommand: 'suppress', text: `${runId} ${findingId}`, userId: 'user-1',
      env: { OPENROUTER_API_KEY: 'k', NEXUS_KV: kv } as unknown as MoltbotEnv,
    }));
    expect(result.kind).toBe('text');
    expect(result.body).toMatch(/Suppressed/);
    expect(result.body).toContain(findingId);
    expect(result.body).toContain('octocat/demo');

    // Persisted as one-key-per-finding under the per-repo prefix. The
    // value is just metadata; the *existence* of the key is the
    // suppression signal.
    const expectedKey = `audit:suppressed:user-1:octocat/demo:${findingId}`;
    expect(store.get(expectedKey)).toBeDefined();
    expect(JSON.parse(store.get(expectedKey)!).at).toEqual(expect.any(String));
  });

  it('is idempotent — second suppress of same id does not duplicate', async () => {
    const { kv, store } = makeKV();
    const { runId, findingId } = seedRun(store, 'user-1');
    await handleAudit(makeRequest({
      subcommand: 'suppress', text: `${runId} ${findingId}`, userId: 'user-1',
      env: { OPENROUTER_API_KEY: 'k', NEXUS_KV: kv } as unknown as MoltbotEnv,
    }));
    const second = await handleAudit(makeRequest({
      subcommand: 'suppress', text: `${runId} ${findingId}`, userId: 'user-1',
      env: { OPENROUTER_API_KEY: 'k', NEXUS_KV: kv } as unknown as MoltbotEnv,
    }));
    expect(second.body).toMatch(/already on the suppression list/);
    // Still exactly one suppression key for this finding (idempotent put
    // is fine; we shouldn't have somehow created multiple keys).
    const supKeys = [...store.keys()].filter(k => k.startsWith('audit:suppressed:user-1:octocat/demo:'));
    expect(supKeys).toHaveLength(1);
  });

  it('unsuppress removes the id; second unsuppress is a no-op', async () => {
    const { kv, store } = makeKV();
    const { runId, findingId } = seedRun(store, 'user-1');
    await handleAudit(makeRequest({
      subcommand: 'suppress', text: `${runId} ${findingId}`, userId: 'user-1',
      env: { OPENROUTER_API_KEY: 'k', NEXUS_KV: kv } as unknown as MoltbotEnv,
    }));
    const removed = await handleAudit(makeRequest({
      subcommand: 'unsuppress', text: `${runId} ${findingId}`, userId: 'user-1',
      env: { OPENROUTER_API_KEY: 'k', NEXUS_KV: kv } as unknown as MoltbotEnv,
    }));
    expect(removed.body).toMatch(/Un-suppressed/);
    // The per-finding key was deleted (no zombie entries).
    const expectedKey = `audit:suppressed:user-1:octocat/demo:${findingId}`;
    expect(store.get(expectedKey)).toBeUndefined();

    // Second unsuppress: nothing to remove.
    const noop = await handleAudit(makeRequest({
      subcommand: 'unsuppress', text: `${runId} ${findingId}`, userId: 'user-1',
      env: { OPENROUTER_API_KEY: 'k', NEXUS_KV: kv } as unknown as MoltbotEnv,
    }));
    expect(noop.body).toMatch(/wasn't on the suppression list/);
  });

  it('rejects malformed runId / findingId without hitting KV', async () => {
    const { kv } = makeKV();
    const r1 = await handleAudit(makeRequest({
      subcommand: 'suppress', text: 'not-a-uuid security-x', userId: 'u',
      env: { NEXUS_KV: kv } as unknown as MoltbotEnv,
    }));
    expect(r1.kind).toBe('error');
    expect(r1.body).toMatch(/not a valid run id/i);

    const r2 = await handleAudit(makeRequest({
      subcommand: 'suppress',
      text: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee NOT_A_REAL_FINDING_ID',
      userId: 'u', env: { NEXUS_KV: kv } as unknown as MoltbotEnv,
    }));
    expect(r2.kind).toBe('error');
    expect(r2.body).toMatch(/not a valid finding id/i);
    expect(kv.get).not.toHaveBeenCalled();
  });

  it('rejects when the run is not found (cross-user attempt)', async () => {
    const { kv, store } = makeKV();
    const { runId, findingId } = seedRun(store, 'user-1');
    const result = await handleAudit(makeRequest({
      subcommand: 'suppress', text: `${runId} ${findingId}`,
      userId: 'user-2', // mismatched
      env: { NEXUS_KV: kv } as unknown as MoltbotEnv,
    }));
    expect(result.kind).toBe('error');
    expect(result.body).toMatch(/no audit run found/i);
  });

  it('rejects when the findingId is not part of the run', async () => {
    const { kv, store } = makeKV();
    const { runId } = seedRun(store, 'user-1');
    const result = await handleAudit(makeRequest({
      subcommand: 'suppress', text: `${runId} security-bogus`, userId: 'user-1',
      env: { NEXUS_KV: kv } as unknown as MoltbotEnv,
    }));
    expect(result.kind).toBe('error');
    expect(result.body).toMatch(/not part of run/i);
  });
});

describe('--analyze: surfaces suppression-read failures (fails LOUD, not silent)', () => {
  it('warns the user when KV.list throws so previously-suppressed findings re-appearing is visible', async () => {
    // Closes GPT slice-4c (PR 511) review follow-up: getSuppressedIds()
    // used to return {} on any KV failure, silently re-surfacing
    // previously-suppressed findings. The new contract returns
    // { ids, error } so the handler can warn the user.
    const tree = [
      { path: 'package.json', type: 'blob', sha: 'm0', size: 30 },
      { path: 'src/auth.ts', type: 'blob', sha: 'a1', size: 30 },
    ];
    installFetchMock([
      { match: (u) => /\/repos\/[^/]+\/[^/]+$/.test(u), body: { default_branch: 'main', private: false, archived: false, size: 1, language: 'TypeScript', description: null } },
      { match: (u) => /\/languages$/.test(u), body: {} },
      { match: (u) => /\/git\/refs\/heads\//.test(u), body: { ref: 'refs/heads/main', object: { sha: 'a'.repeat(40) } } },
      { match: (u) => /\/git\/trees\//.test(u), body: { truncated: false, tree } },
      { match: (u) => u.includes('/contents/package.json'), body: { encoding: 'base64', content: btoa('{"name":"x"}'), sha: 'm0', size: 30 } },
      { match: (u) => u.includes('/contents/src/auth.ts'), body: { encoding: 'base64', content: btoa('export const x = 1;'), sha: 'a1', size: 30 } },
      { match: (u) => u.includes('/code-scanning/alerts'), status: 404, body: {} },
    ]);

    mockLLM.mockResolvedValue({
      text: JSON.stringify({
        findings: [{
          lens: 'security', severity: 'high', confidence: 0.75,
          symptom: 'Some defect', rootCause: 'r', correctiveAction: 'c',
          preventiveAction: { kind: 'lint', detail: 'rule' },
          evidence: [{ path: 'src/auth.ts', lines: '1-1', snippet: 'x' }],
        }],
      }),
    });

    // KV that throws on .list() — simulates a network blip / quota error
    // mid-audit. Critical: the audit MUST still complete (suppression is
    // best-effort), but MUST surface a warning so the user knows the
    // suppression list wasn't applied.
    const kv = {
      get: vi.fn(async () => null),
      put: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(async () => { throw new Error('KV unavailable'); }),
    } as unknown as KVNamespace;

    const result = await handleAudit(makeRequest({
      flags: { analyze: 'true', lens: 'security' },
      userId: 'user-1',
      env: { GITHUB_TOKEN: 'tok', OPENROUTER_API_KEY: 'k', NEXUS_KV: kv } as unknown as MoltbotEnv,
    }));
    expect(result.kind).toBe('audit_run');
    // Audit completes — finding is in the run as normal (no false drop).
    const run = result.data as AuditRun;
    expect(run.findings).toHaveLength(1);
    expect(run.findings[0].suppressed).toBeUndefined();
    // The user-visible body MUST include the warning so they know
    // previously-suppressed findings may be re-appearing.
    expect(result.body).toMatch(/Suppression list could not be read/);
    expect(result.body).toMatch(/KV unavailable/);
  });

  it('does NOT show the warning on a normal run (no KV error)', async () => {
    const tree = [
      { path: 'package.json', type: 'blob', sha: 'm0', size: 30 },
      { path: 'src/auth.ts', type: 'blob', sha: 'a1', size: 30 },
    ];
    installFetchMock([
      { match: (u) => /\/repos\/[^/]+\/[^/]+$/.test(u), body: { default_branch: 'main', private: false, archived: false, size: 1, language: 'TypeScript', description: null } },
      { match: (u) => /\/languages$/.test(u), body: {} },
      { match: (u) => /\/git\/refs\/heads\//.test(u), body: { ref: 'refs/heads/main', object: { sha: 'a'.repeat(40) } } },
      { match: (u) => /\/git\/trees\//.test(u), body: { truncated: false, tree } },
      { match: (u) => u.includes('/contents/package.json'), body: { encoding: 'base64', content: btoa('{"name":"x"}'), sha: 'm0', size: 30 } },
      { match: (u) => u.includes('/contents/src/auth.ts'), body: { encoding: 'base64', content: btoa('export const x = 1;'), sha: 'a1', size: 30 } },
      { match: (u) => u.includes('/code-scanning/alerts'), status: 404, body: {} },
    ]);
    mockLLM.mockResolvedValue({ text: JSON.stringify({ findings: [] }) });

    // KV that works normally (empty suppression list).
    const kv = {
      get: vi.fn(async () => null),
      put: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(async () => ({ keys: [], list_complete: true, cursor: undefined })),
    } as unknown as KVNamespace;

    const result = await handleAudit(makeRequest({
      flags: { analyze: 'true', lens: 'security' },
      userId: 'user-1',
      env: { GITHUB_TOKEN: 'tok', OPENROUTER_API_KEY: 'k', NEXUS_KV: kv } as unknown as MoltbotEnv,
    }));
    expect(result.kind).toBe('audit_run');
    // No warning on the happy path.
    expect(result.body).not.toMatch(/Suppression list could not be read/);
  });
});

describe('--analyze: applies per-repo suppression list before persist+display', () => {
  it('persists suppressed findings with suppressed:true (transparent for export) but excludes them from the inline view', async () => {
    const tree = [
      { path: 'package.json', type: 'blob', sha: 'm0', size: 30 },
      { path: 'src/auth.ts', type: 'blob', sha: 'a1', size: 30 },
    ];
    installFetchMock([
      { match: (u) => /\/repos\/[^/]+\/[^/]+$/.test(u), body: { default_branch: 'main', private: false, archived: false, size: 1, language: 'TypeScript', description: null } },
      { match: (u) => /\/languages$/.test(u), body: {} },
      { match: (u) => /\/git\/refs\/heads\//.test(u), body: { ref: 'refs/heads/main', object: { sha: 'a'.repeat(40) } } },
      { match: (u) => /\/git\/trees\//.test(u), body: { truncated: false, tree } },
      { match: (u) => u.includes('/contents/package.json'), body: { encoding: 'base64', content: btoa('{"name":"x"}'), sha: 'm0', size: 30 } },
      { match: (u) => u.includes('/contents/src/auth.ts'), body: { encoding: 'base64', content: btoa('export const x = 1;'), sha: 'a1', size: 30 } },
      { match: (u) => u.includes('/code-scanning/alerts'), status: 404, body: {} },
    ]);

    // Compute the finding-id deterministically (the validator hashes
    // (lens, path, symptom)); we'll mirror the LLM response so the
    // resulting id matches what we pre-suppress.
    const symptom = 'Hardcoded TOKEN literal';
    mockLLM.mockResolvedValue({
      text: JSON.stringify({
        findings: [
          { lens: 'security', severity: 'high', confidence: 0.75,
            symptom, rootCause: 'r', correctiveAction: 'c',
            preventiveAction: { kind: 'lint', detail: 'rule' },
            evidence: [{ path: 'src/auth.ts', lines: '1-1', snippet: 'TOKEN' }] },
        ],
      }),
    });

    // Pre-seed suppression for the id this finding will get. The id is
    // computed from (lens, evidence[0].path, symptom) — we replicate the
    // validator's djb2 hash here so the test's expectation is deterministic
    // without coupling to private internals.
    const seed = `security|src/auth.ts|${symptom}`;
    let h = 5381 >>> 0;
    for (let i = 0; i < seed.length; i++) h = ((h * 33) ^ seed.charCodeAt(i)) >>> 0;
    const expectedId = `security-${h.toString(36)}`;

    const kvStore = new Map<string, string>();
    // One-key-per-finding suppression: the existence of the key is the signal.
    kvStore.set(`audit:suppressed:user-1:octocat/hello-world:${expectedId}`, JSON.stringify({ at: 'now' }));
    const kv = {
      get: vi.fn(async (key: string, type?: string) => {
        const v = kvStore.get(key);
        if (v === undefined) return null;
        return type === 'json' ? JSON.parse(v) : v;
      }),
      put: vi.fn(async (key: string, value: string) => { kvStore.set(key, value); }),
      delete: vi.fn(async (key: string) => { kvStore.delete(key); }),
      list: vi.fn(async ({ prefix }: { prefix: string }) => {
        const keys = [...kvStore.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name }));
        return { keys, list_complete: true, cursor: undefined };
      }),
    } as unknown as KVNamespace;

    const result = await handleAudit(makeRequest({
      flags: { analyze: 'true', lens: 'security' },
      userId: 'user-1',
      env: { GITHUB_TOKEN: 'tok', OPENROUTER_API_KEY: 'k', NEXUS_KV: kv } as unknown as MoltbotEnv,
    }));
    expect(result.kind).toBe('audit_run');
    const run = result.data as AuditRun;

    // Suppressed findings are PERSISTED with suppressed:true (transparency
    // for /audit export — closes GPT slice-4c review finding 2). They are
    // excluded from the inline body view; the count is surfaced.
    expect(run.findings).toHaveLength(1);
    expect(run.findings[0].id).toBe(expectedId);
    expect(run.findings[0].suppressed).toBe(true);
    // Inline body does NOT show the suppressed finding's symptom in the
    // "Findings" list, and the suppression count is announced.
    expect(result.body).toMatch(/1 finding\(s\) suppressed/);
    expect(result.body).toMatch(/No defects found/); // active list is empty
  });
});

describe('nested manifest discovery (monorepo support)', () => {
  it('discovers package.json and other manifests in subdirectories', async () => {
    const monorepoTree = [
      { path: 'package.json', type: 'blob', sha: 'm0', size: 100 },
      { path: 'apps/web/package.json', type: 'blob', sha: 'm1', size: 100 },
      { path: 'apps/api/package.json', type: 'blob', sha: 'm2', size: 100 },
      { path: 'packages/shared/package.json', type: 'blob', sha: 'm3', size: 100 },
      { path: 'packages/shared/tsconfig.json', type: 'blob', sha: 'm4', size: 100 },
      // Vendored manifests must be skipped
      { path: 'node_modules/lodash/package.json', type: 'blob', sha: 'm5', size: 100 },
    ];
    let manifestFetches: string[] = [];
    installFetchMock([
      {
        match: (u) => /\/repos\/[^/]+\/[^/]+$/.test(u),
        body: { default_branch: 'main', private: false, archived: false, size: 1, language: 'TypeScript', description: null },
      },
      { match: (u) => /\/languages$/.test(u), body: { TypeScript: 1 } },
      {
        match: (u) => /\/git\/refs\/heads\//.test(u),
        body: { ref: 'refs/heads/main', object: { sha: 'f'.repeat(40) } },
      },
      { match: (u) => /\/git\/trees\//.test(u), body: { truncated: false, tree: monorepoTree } },
      {
        match: (u) => {
          const m = /\/contents\/(.+?)\?ref=/.exec(u);
          if (m) manifestFetches.push(decodeURIComponent(m[1]));
          return !!m;
        },
        body: { encoding: 'base64', content: btoa('{"name":"x"}'), sha: 'x', size: 100 },
      },
      { match: (u) => u.includes('/code-scanning/alerts'), status: 404, body: {} },
    ]);

    const r = await handleAudit(makeRequest());
    expect(r.kind).toBe('audit_plan');
    const plan = r.data as AuditPlan;
    const fetchedPaths = plan.profile.manifests.map(m => m.path);
    expect(fetchedPaths).toContain('package.json');
    expect(fetchedPaths).toContain('apps/web/package.json');
    expect(fetchedPaths).toContain('apps/api/package.json');
    expect(fetchedPaths).toContain('packages/shared/package.json');
    expect(fetchedPaths).toContain('packages/shared/tsconfig.json');
    // Vendored manifests excluded
    expect(fetchedPaths).not.toContain('node_modules/lodash/package.json');
  });
});

// ---------------------------------------------------------------------------
// Slice 4d follow-up — Fix dispatch draft token (PR 513 review findings 1+2)
// ---------------------------------------------------------------------------

describe('fix dispatch draft tokens', () => {
  function makeKV() {
    const store = new Map<string, string>();
    const kv = {
      get: vi.fn(async (key: string, type?: string) => {
        const v = store.get(key);
        if (v === undefined) return null;
        return type === 'json' ? JSON.parse(v) : v;
      }),
      put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
      delete: vi.fn(async (key: string) => { store.delete(key); }),
    } as unknown as KVNamespace;
    return { kv, store };
  }

  it('newFixDraftToken produces 16 hex chars (per-user KV scope makes 64 bits enough)', async () => {
    const { newFixDraftToken } = await import('./cache');
    const t = newFixDraftToken();
    expect(t).toMatch(/^[0-9a-f]{16}$/);
    // Two consecutive tokens must differ (sanity on randomness)
    expect(newFixDraftToken()).not.toBe(t);
  });

  it('cache + consume round-trips the prepared taskText verbatim', async () => {
    const { cacheFixDraft, consumeFixDraft, newFixDraftToken } = await import('./cache');
    const { kv, store } = makeKV();
    const token = newFixDraftToken();
    const draft = {
      runId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      findingId: 'security-abc',
      taskText: 'Fix audit finding...\n\nMulti-line content with --flags and YAML.',
      owner: 'octocat', repo: 'demo',
      severity: 'high', lens: 'security',
      createdAt: '2026-04-26T00:00:00.000Z',
    };
    await cacheFixDraft(kv, 'user-1', token, draft);
    expect(store.get(`audit:fixdraft:user-1:${token}`)).toBeDefined();

    const consumed = await consumeFixDraft(kv, 'user-1', token);
    expect(consumed).toEqual(draft);
    // Confirm consumed = deleted: a second consume returns null
    const second = await consumeFixDraft(kv, 'user-1', token);
    expect(second).toBeNull();
  });

  it('consume returns null for an unknown token (expired / never created)', async () => {
    const { consumeFixDraft } = await import('./cache');
    const { kv } = makeKV();
    expect(await consumeFixDraft(kv, 'user-1', 'deadbeefdeadbeef')).toBeNull();
  });

  it('cross-user token cannot be consumed (per-user KV scope)', async () => {
    const { cacheFixDraft, consumeFixDraft, newFixDraftToken } = await import('./cache');
    const { kv } = makeKV();
    const token = newFixDraftToken();
    await cacheFixDraft(kv, 'user-1', token, {
      runId: 'r', findingId: 'f', taskText: 't',
      owner: 'o', repo: 'r', severity: 'low', lens: 'tests',
      createdAt: 'now',
    });
    expect(await consumeFixDraft(kv, 'user-2', token)).toBeNull();
    // user-1 can still consume — user-2's miss didn't disturb it
    expect(await consumeFixDraft(kv, 'user-1', token)).not.toBeNull();
  });

  it('deleteFixDraft is idempotent (cancel path)', async () => {
    const { cacheFixDraft, deleteFixDraft, consumeFixDraft, newFixDraftToken } = await import('./cache');
    const { kv } = makeKV();
    const token = newFixDraftToken();
    await cacheFixDraft(kv, 'user-1', token, {
      runId: 'r', findingId: 'f', taskText: 't', owner: 'o', repo: 'r', severity: 'low', lens: 'tests', createdAt: 'now',
    });
    await deleteFixDraft(kv, 'user-1', token);
    await deleteFixDraft(kv, 'user-1', token); // second call must not throw
    expect(await consumeFixDraft(kv, 'user-1', token)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PR 514 review: cacheFixDraft returns boolean; bad-token shape rejected
// ---------------------------------------------------------------------------

describe('cacheFixDraft return value (closes PR 514 follow-up #1)', () => {
  it('returns true when the put succeeds', async () => {
    const { cacheFixDraft, newFixDraftToken } = await import('./cache');
    const store = new Map<string, string>();
    const kv = {
      get: vi.fn(async () => null),
      put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
      delete: vi.fn(),
    } as unknown as KVNamespace;

    const ok = await cacheFixDraft(kv, 'user-1', newFixDraftToken(), {
      runId: 'r', findingId: 'f', taskText: 't', owner: 'o', repo: 'r',
      severity: 'low', lens: 'tests', createdAt: 'now',
    });
    expect(ok).toBe(true);
    expect(store.size).toBe(1);
  });

  it('returns false when KV put throws (callers gate Confirm button on this)', async () => {
    const { cacheFixDraft, newFixDraftToken } = await import('./cache');
    const kv = {
      get: vi.fn(async () => null),
      put: vi.fn(async () => { throw new Error('KV unavailable'); }),
      delete: vi.fn(),
    } as unknown as KVNamespace;

    const ok = await cacheFixDraft(kv, 'user-1', newFixDraftToken(), {
      runId: 'r', findingId: 'f', taskText: 't', owner: 'o', repo: 'r',
      severity: 'low', lens: 'tests', createdAt: 'now',
    });
    expect(ok).toBe(false);
  });

  it('returns false when KV is undefined', async () => {
    const { cacheFixDraft, newFixDraftToken } = await import('./cache');
    const ok = await cacheFixDraft(undefined, 'user-1', newFixDraftToken(), {
      runId: 'r', findingId: 'f', taskText: 't', owner: 'o', repo: 'r',
      severity: 'low', lens: 'tests', createdAt: 'now',
    });
    expect(ok).toBe(false);
  });
});

describe('FIX_TOKEN_RE shape (closes PR 514 follow-up #3)', () => {
  // The regex is the same one used in the handler's audit:go / audit:no
  // gates; we re-declare it here so the contract is testable without
  // booting the TelegramHandler scaffold.
  const FIX_TOKEN_RE = /^[0-9a-f]{16}$/i;

  it('accepts a real newFixDraftToken() output', async () => {
    const { newFixDraftToken } = await import('./cache');
    for (let i = 0; i < 50; i++) {
      expect(FIX_TOKEN_RE.test(newFixDraftToken())).toBe(true);
    }
  });

  it.each([
    ['empty',                ''],
    ['too short',            '0123456789abcde'],     // 15 chars
    ['too long',             '0123456789abcdef0'],   // 17 chars
    ['non-hex chars',        'gggggggggggggggg'],
    ['runId shape',          'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'],
    ['hex with dashes',      '0123-4567-89ab-cdef'], // wrong shape
    ['SQL-injection-y',      "0' OR 1=1--      "],
    ['suppression-key path', 'audit:fixdraft:user'],
  ])('rejects %s', (_label, bad) => {
    expect(FIX_TOKEN_RE.test(bad)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// /audit subscribe | unsubscribe | subs (Phase 1, Slice A)
// ---------------------------------------------------------------------------

describe('/audit subscribe', () => {
  function kvWithStore() {
    const store = new Map<string, string>();
    const kv = {
      get: vi.fn(async (key: string, type?: string) => {
        const v = store.get(key);
        if (v === undefined) return null;
        return type === 'json' ? JSON.parse(v) : v;
      }),
      put: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        store.delete(key);
      }),
      list: vi.fn(async (opts: { prefix?: string }) => {
        const prefix = opts.prefix ?? '';
        return {
          keys: [...store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })),
          list_complete: true,
        };
      }),
    } as unknown as KVNamespace;
    return { kv, store };
  }

  function makeSubReq(overrides: Partial<SkillRequest> = {}): SkillRequest {
    return {
      skillId: 'audit',
      subcommand: 'subscribe',
      text: 'octocat/hello-world',
      flags: {},
      transport: 'telegram',
      userId: 'user-1',
      chatId: 1234,
      env: {
        NEXUS_KV: undefined as unknown as KVNamespace,
        GITHUB_TOKEN: 'tok',
      } as unknown as MoltbotEnv,
      ...overrides,
    };
  }

  it('creates a subscription with sane defaults (weekly, quick, all lenses)', async () => {
    const { kv, store } = kvWithStore();
    const result = await handleAudit(makeSubReq({
      env: { NEXUS_KV: kv } as unknown as MoltbotEnv,
    }));
    expect(result.kind).toBe('text');
    expect(result.body).toMatch(/Subscribed octocat\/hello-world/);
    expect(result.body).toMatch(/weekly/);

    const stored = JSON.parse(store.get('audit:sub:user-1:octocat/hello-world')!);
    expect(stored.interval).toBe('weekly');
    expect(stored.depth).toBe('quick');
    expect(stored.lens).toBeUndefined();
    expect(stored.chatId).toBe(1234);
    expect(stored.lastRunAt).toBeNull();
  });

  it('honors --daily, --lens, --depth, --branch', async () => {
    const { kv, store } = kvWithStore();
    await handleAudit(makeSubReq({
      flags: { daily: 'true', lens: 'security', depth: 'standard', branch: 'main' },
      env: { NEXUS_KV: kv } as unknown as MoltbotEnv,
    }));
    const stored = JSON.parse(store.get('audit:sub:user-1:octocat/hello-world')!);
    expect(stored.interval).toBe('daily');
    expect(stored.lens).toBe('security');
    expect(stored.depth).toBe('standard');
    expect(stored.branch).toBe('main');
  });

  it('rejects unknown lens', async () => {
    const { kv } = kvWithStore();
    const result = await handleAudit(makeSubReq({
      flags: { lens: 'nonsense' },
      env: { NEXUS_KV: kv } as unknown as MoltbotEnv,
    }));
    expect(result.kind).toBe('error');
    expect(result.body).toMatch(/Unknown --lens/);
  });

  it('rejects unknown depth', async () => {
    const { kv } = kvWithStore();
    const result = await handleAudit(makeSubReq({
      flags: { depth: 'extreme' },
      env: { NEXUS_KV: kv } as unknown as MoltbotEnv,
    }));
    expect(result.kind).toBe('error');
    expect(result.body).toMatch(/Unknown --depth/);
  });

  it('rejects when transport is not telegram', async () => {
    const { kv } = kvWithStore();
    const result = await handleAudit(makeSubReq({
      transport: 'web',
      env: { NEXUS_KV: kv } as unknown as MoltbotEnv,
    }));
    expect(result.kind).toBe('error');
    expect(result.body).toMatch(/Telegram-only/);
  });

  it('rejects when chatId is missing', async () => {
    const { kv } = kvWithStore();
    const result = await handleAudit(makeSubReq({
      chatId: undefined,
      env: { NEXUS_KV: kv } as unknown as MoltbotEnv,
    }));
    expect(result.kind).toBe('error');
    expect(result.body).toMatch(/chat context/);
  });

  it('rejects when no repo is provided', async () => {
    const { kv } = kvWithStore();
    const result = await handleAudit(makeSubReq({
      text: '',
      env: { NEXUS_KV: kv } as unknown as MoltbotEnv,
    }));
    expect(result.kind).toBe('error');
    expect(result.body).toMatch(/Usage:/);
  });

  it('preserves lastRunAt/lastRunId when an existing subscription is updated', async () => {
    const { kv, store } = kvWithStore();
    // Pre-seed an existing subscription that has already run once.
    const seeded = {
      userId: 'user-1',
      owner: 'octocat',
      repo: 'hello-world',
      transport: 'telegram',
      chatId: 1234,
      depth: 'quick',
      interval: 'weekly',
      createdAt: '2026-01-01T00:00:00Z',
      lastRunAt: '2026-04-10T00:00:00Z',
      lastRunId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    };
    store.set('audit:sub:user-1:octocat/hello-world', JSON.stringify(seeded));

    const result = await handleAudit(makeSubReq({
      flags: { daily: 'true' },
      env: { NEXUS_KV: kv } as unknown as MoltbotEnv,
    }));
    expect(result.body).toMatch(/Updated/);
    const updated = JSON.parse(store.get('audit:sub:user-1:octocat/hello-world')!);
    expect(updated.interval).toBe('daily');
    expect(updated.createdAt).toBe(seeded.createdAt);    // unchanged
    expect(updated.lastRunAt).toBe(seeded.lastRunAt);    // unchanged
    expect(updated.lastRunId).toBe(seeded.lastRunId);    // unchanged
  });
});

describe('/audit unsubscribe', () => {
  it('removes an existing subscription', async () => {
    const store = new Map<string, string>();
    const seeded = {
      userId: 'user-1', owner: 'octocat', repo: 'demo', transport: 'telegram',
      chatId: 1, depth: 'quick', interval: 'weekly', createdAt: 't', lastRunAt: null, lastRunId: null,
    };
    store.set('audit:sub:user-1:octocat/demo', JSON.stringify(seeded));
    const kv = {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      delete: vi.fn(async (k: string) => { store.delete(k); }),
    } as unknown as KVNamespace;

    const result = await handleAudit({
      skillId: 'audit',
      subcommand: 'unsubscribe',
      text: 'octocat/demo',
      flags: {},
      transport: 'telegram',
      userId: 'user-1',
      env: { NEXUS_KV: kv } as unknown as MoltbotEnv,
    } as SkillRequest);

    expect(result.kind).toBe('text');
    expect(result.body).toMatch(/Unsubscribed/);
    expect(store.has('audit:sub:user-1:octocat/demo')).toBe(false);
  });

  it('returns a friendly message when nothing is subscribed', async () => {
    const kv = {
      get: vi.fn(async () => null),
      delete: vi.fn(),
    } as unknown as KVNamespace;
    const result = await handleAudit({
      skillId: 'audit',
      subcommand: 'unsubscribe',
      text: 'octocat/demo',
      flags: {},
      transport: 'telegram',
      userId: 'user-1',
      env: { NEXUS_KV: kv } as unknown as MoltbotEnv,
    } as SkillRequest);

    expect(result.kind).toBe('text');
    expect(result.body).toMatch(/No active subscription/);
  });

  it('rejects when no repo is given', async () => {
    const result = await handleAudit({
      skillId: 'audit',
      subcommand: 'unsubscribe',
      text: '',
      flags: {},
      transport: 'telegram',
      userId: 'user-1',
      env: { NEXUS_KV: {} as KVNamespace } as unknown as MoltbotEnv,
    } as SkillRequest);
    expect(result.kind).toBe('error');
    expect(result.body).toMatch(/Usage:/);
  });
});

describe('/audit subs (list)', () => {
  it('returns an empty-state message when there are no subscriptions', async () => {
    const kv = {
      list: vi.fn(async () => ({ keys: [], list_complete: true })),
    } as unknown as KVNamespace;
    const result = await handleAudit({
      skillId: 'audit',
      subcommand: 'subs',
      text: '',
      flags: {},
      transport: 'telegram',
      userId: 'user-1',
      env: { NEXUS_KV: kv } as unknown as MoltbotEnv,
    } as SkillRequest);
    expect(result.kind).toBe('text');
    expect(result.body).toMatch(/No active audit subscriptions/);
  });

  it('lists user subscriptions sorted by createdAt', async () => {
    const store = new Map<string, string>();
    store.set(
      'audit:sub:user-1:b/b',
      JSON.stringify({
        userId: 'user-1', owner: 'b', repo: 'b', transport: 'telegram', chatId: 1,
        depth: 'quick', interval: 'daily', createdAt: '2026-02-01T00:00:00Z',
        lastRunAt: '2026-04-20T00:00:00Z', lastRunId: 'rid',
      }),
    );
    store.set(
      'audit:sub:user-1:a/a',
      JSON.stringify({
        userId: 'user-1', owner: 'a', repo: 'a', transport: 'telegram', chatId: 1,
        depth: 'standard', interval: 'weekly', createdAt: '2026-01-01T00:00:00Z',
        lastRunAt: null, lastRunId: null, lens: 'security',
      }),
    );
    const kv = {
      get: vi.fn(async (k: string, type?: string) => {
        const v = store.get(k);
        if (v === undefined) return null;
        return type === 'json' ? JSON.parse(v) : v;
      }),
      list: vi.fn(async (opts: { prefix?: string }) => ({
        keys: [...store.keys()].filter(k => k.startsWith(opts.prefix ?? '')).map(name => ({ name })),
        list_complete: true,
      })),
    } as unknown as KVNamespace;

    const result = await handleAudit({
      skillId: 'audit',
      subcommand: 'subs',
      text: '',
      flags: {},
      transport: 'telegram',
      userId: 'user-1',
      env: { NEXUS_KV: kv } as unknown as MoltbotEnv,
    } as SkillRequest);

    expect(result.kind).toBe('text');
    // Older sub renders before newer one.
    const aIdx = result.body.indexOf('a/a');
    const bIdx = result.body.indexOf('b/b');
    expect(aIdx).toBeGreaterThan(-1);
    expect(bIdx).toBeGreaterThan(aIdx);
    expect(result.body).toMatch(/never run/);              // a/a
    expect(result.body).toMatch(/last run 2026-04-20/);    // b/b
    expect(result.body).toMatch(/security/);               // a/a's lens
  });
});

describe('buildScheduledAuditRequest', () => {
  it('produces an --analyze SkillRequest matching subscription knobs', () => {
    const sub = {
      userId: 'u', owner: 'o', repo: 'r', transport: 'telegram' as const, chatId: 5,
      depth: 'standard' as const, interval: 'daily' as const,
      lens: 'security', branch: 'main',
      createdAt: 't', lastRunAt: null, lastRunId: null,
    };
    const env = { NEXUS_KV: {} as KVNamespace } as unknown as MoltbotEnv;
    const built = buildScheduledAuditRequest(sub, env, undefined);
    expect(built.subcommand).toBe('run');
    expect(built.text).toBe('o/r');
    expect(built.flags).toEqual({ analyze: 'true', depth: 'standard', lens: 'security', branch: 'main' });
    expect(built.userId).toBe('u');
    expect(built.chatId).toBe(5);
  });

  it('omits lens/branch when subscription leaves them undefined', () => {
    const built = buildScheduledAuditRequest(
      {
        userId: 'u', owner: 'o', repo: 'r', transport: 'telegram', chatId: 1,
        depth: 'quick', interval: 'weekly',
        createdAt: 't', lastRunAt: null, lastRunId: null,
      },
      {} as unknown as MoltbotEnv,
      undefined,
    );
    expect(built.flags).toEqual({ analyze: 'true', depth: 'quick' });
  });
});
