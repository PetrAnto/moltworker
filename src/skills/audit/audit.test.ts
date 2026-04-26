/**
 * Audit Skill — Handler tests
 *
 * Mocks `fetch` at the module boundary so we exercise the Scout pipeline
 * end-to-end without hitting the real GitHub API.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleAudit } from './audit';
import { parseRepoCoords } from './scout';
import { fileMatchesLens, depthBudget } from './lenses';
import { profileCacheKey } from './cache';
import { findingPriority, isLens, isDepth } from './types';
import type { AuditPlan, RepoProfile, AuditFinding, TreeEntry } from './types';
import type { SkillRequest } from '../types';
import type { MoltbotEnv } from '../../types';

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
