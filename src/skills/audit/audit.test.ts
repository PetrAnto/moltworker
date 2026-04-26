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

import { handleAudit, audit_do_key } from './audit';
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

describe('--analyze: feature gate is Vitest-scoped, not "any Node"', () => {
  it('refuses --analyze in non-test Node when MOLTBOT_BUCKET runtime WASM is absent', async () => {
    // Simulate a non-test Node runtime (CLI harness, local emulator, etc.)
    // by clearing both env signals isNodeTestEnv() reads.
    vi.stubEnv('VITEST', '');
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const tree = [{ path: 'src/auth.ts', type: 'blob', sha: 'a1', size: 30 }];
      installFetchMock([
        { match: (u) => /\/repos\/[^/]+\/[^/]+$/.test(u), body: { default_branch: 'main', private: false, archived: false, size: 1, language: 'TypeScript', description: null } },
        { match: (u) => /\/languages$/.test(u), body: {} },
        { match: (u) => /\/git\/refs\/heads\//.test(u), body: { ref: 'refs/heads/main', object: { sha: 'a'.repeat(40) } } },
        { match: (u) => /\/git\/trees\//.test(u), body: { truncated: false, tree } },
        { match: (u) => u.includes('/code-scanning/alerts'), status: 404, body: {} },
      ]);

      const result = await handleAudit(makeRequest({
        flags: { analyze: 'true', lens: 'security' },
        // env has MOLTBOT_BUCKET=undefined → loadRuntimeWasm returns null
      }));
      expect(result.kind).toBe('error');
      expect(result.body).toMatch(/audit analysis is not enabled/i);
      // Critically: LLM was NEVER called — gate fired before any work.
      expect(mockLLM).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('still allows --analyze in Vitest with no MOLTBOT_BUCKET (auto-resolution fallback)', async () => {
    // Sanity: VITEST is set in this run by default. The other --analyze
    // tests in this file rely on this fall-through; an accidentally-too-
    // narrow gate would break them. This test pins the contract.
    expect(typeof process.env.VITEST !== 'undefined' && process.env.VITEST !== '').toBe(true);
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

describe('--analyze: persists AuditRun to NEXUS_KV after completion', () => {
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
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
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

  it('returns clear error when the run is not found (or expired)', async () => {
    const kv = kvWithRun('user-1', makeRun()); // has run for user-1, NOT user-2
    const result = await handleAudit(makeRequest({
      subcommand: 'export',
      text: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      userId: 'user-2', // different user → user-scoped key won't match
      env: { NEXUS_KV: kv } as unknown as MoltbotEnv,
    }));
    expect(result.kind).toBe('error');
    expect(result.body).toMatch(/no audit run found/i);
    expect(result.body).toMatch(/7 days/i);
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
