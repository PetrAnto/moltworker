/**
 * Audit Skill — OSV.dev cross-reference tests
 *
 * Covers manifest extraction (which deps get queried), version
 * normalization (range-spec → exact version), the batch + per-id fetch
 * round-trip, severity mapping, and graceful degradation on network /
 * API failures.
 */

import { describe, it, expect, vi } from 'vitest';
import { collectQueries, lookupOsvAdvisories, normalizeNpmVersion } from './osv';
import type { ManifestFile } from './types';

function pkgJson(path: string, body: unknown): ManifestFile {
  return { path, content: JSON.stringify(body), sha: 'mockedsha' };
}

describe('normalizeNpmVersion', () => {
  it('strips ^ / ~ / range operators down to the floor semver triple', () => {
    expect(normalizeNpmVersion('^1.2.3')).toBe('1.2.3');
    expect(normalizeNpmVersion('~1.2.3')).toBe('1.2.3');
    expect(normalizeNpmVersion('>=1.2.3 <2')).toBe('1.2.3');
    expect(normalizeNpmVersion('1.2.3')).toBe('1.2.3');
  });

  it('preserves prerelease tags so prerelease-only advisories still match', () => {
    expect(normalizeNpmVersion('1.2.3-beta.4')).toBe('1.2.3-beta.4');
  });

  it('returns null for non-version specifiers OSV cannot match', () => {
    expect(normalizeNpmVersion('*')).toBeNull();
    expect(normalizeNpmVersion('latest')).toBeNull();
    expect(normalizeNpmVersion('workspace:*')).toBeNull();
    expect(normalizeNpmVersion('file:../foo')).toBeNull();
    expect(normalizeNpmVersion('git+https://x/y.git')).toBeNull();
    expect(normalizeNpmVersion('npm:other-pkg@^1.0.0')).toBeNull();
    expect(normalizeNpmVersion('')).toBeNull();
  });
});

describe('collectQueries', () => {
  it('extracts dependencies + devDependencies + peerDependencies from package.json', () => {
    const m = pkgJson('package.json', {
      dependencies: { lodash: '^4.17.20' },
      devDependencies: { vitest: '~1.0.0' },
      peerDependencies: { react: '^18.0.0' },
    });
    const out = collectQueries([m]);
    expect(out.map((q) => q.packageName).sort()).toEqual(['lodash', 'react', 'vitest']);
    expect(out.every((q) => q.ecosystem === 'npm')).toBe(true);
    expect(out.every((q) => q.manifestPath === 'package.json')).toBe(true);
  });

  it('handles nested package.json files for monorepo coverage', () => {
    const root = pkgJson('package.json', { dependencies: { lodash: '4.17.20' } });
    const sub = pkgJson('packages/api/package.json', {
      dependencies: { express: '4.18.0' },
    });
    const out = collectQueries([root, sub]);
    const expressEntry = out.find((q) => q.packageName === 'express');
    expect(expressEntry?.manifestPath).toBe('packages/api/package.json');
  });

  it('de-dupes the same (name, version) pair across sections', () => {
    const m = pkgJson('package.json', {
      dependencies: { lodash: '4.17.20' },
      devDependencies: { lodash: '4.17.20' }, // same version
    });
    const out = collectQueries([m]);
    expect(out.filter((q) => q.packageName === 'lodash').length).toBe(1);
  });

  it('skips manifests with null content (oversized) and non-package.json files', () => {
    const out = collectQueries([
      { path: 'package.json', content: null, sha: 'x' },
      pkgJson('Cargo.toml', { dependencies: { lodash: '4.17.20' } }),
    ]);
    expect(out).toEqual([]);
  });

  it('ignores non-version specifiers without crashing', () => {
    const m = pkgJson('package.json', {
      dependencies: { 'local-pkg': 'file:../local', other: '*', lodash: '^4.17.20' },
    });
    const out = collectQueries([m]);
    expect(out.map((q) => q.packageName)).toEqual(['lodash']);
  });
});

describe('lookupOsvAdvisories', () => {
  function makeFetchMock(handlers: {
    batch?: (body: unknown) => unknown;
    vuln?: (id: string) => unknown | null;
  }): typeof fetch {
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      if (url === 'https://api.osv.dev/v1/querybatch') {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        const out = handlers.batch ? handlers.batch(body) : { results: [] };
        return new Response(JSON.stringify(out), { status: 200 });
      }
      if (url.startsWith('https://api.osv.dev/v1/vulns/')) {
        const id = decodeURIComponent(url.slice('https://api.osv.dev/v1/vulns/'.length));
        const out = handlers.vuln ? handlers.vuln(id) : null;
        if (out == null) {
          return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
        }
        return new Response(JSON.stringify(out), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }) as unknown as typeof fetch;
  }

  it('returns empty alerts (not failed) when no manifests have queryable deps', async () => {
    const result = await lookupOsvAdvisories([], makeFetchMock({}));
    expect(result.alerts).toEqual([]);
    expect(result.failed).toBe(false);
  });

  it('round-trips advisories from batch + per-id detail fetches', async () => {
    const fetchImpl = makeFetchMock({
      batch: () => ({
        results: [
          { vulns: [{ id: 'GHSA-abcd-1234-efgh' }] }, // lodash
        ],
      }),
      vuln: (id) => ({
        id,
        summary: 'Prototype pollution in lodash',
        severity: [{ type: 'CVSS_V3', score: '9.1' }],
        references: [{ type: 'ADVISORY', url: 'https://example.com/ghsa-abcd' }],
      }),
    });

    const result = await lookupOsvAdvisories(
      [pkgJson('package.json', { dependencies: { lodash: '4.17.20' } })],
      fetchImpl,
    );

    expect(result.failed).toBe(false);
    expect(result.alerts.length).toBe(1);
    const a = result.alerts[0];
    expect(a.id).toBe('GHSA-abcd-1234-efgh');
    expect(a.packageName).toBe('lodash');
    expect(a.affectedVersion).toBe('4.17.20');
    expect(a.severity).toBe('critical'); // 9.1 → critical
    expect(a.summary).toContain('Prototype pollution');
    expect(a.url).toBe('https://example.com/ghsa-abcd');
  });

  it('uses database_specific.severity when present (more reliable than CVSS heuristics)', async () => {
    const fetchImpl = makeFetchMock({
      batch: () => ({ results: [{ vulns: [{ id: 'GHSA-x' }] }] }),
      vuln: () => ({ id: 'GHSA-x', summary: 's', database_specific: { severity: 'high' } }),
    });
    const result = await lookupOsvAdvisories(
      [pkgJson('package.json', { dependencies: { lodash: '4.17.20' } })],
      fetchImpl,
    );
    expect(result.alerts[0].severity).toBe('high');
  });

  it('reports failed=true on a network error (caller surfaces a partial-coverage warning)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;
    const result = await lookupOsvAdvisories(
      [pkgJson('package.json', { dependencies: { lodash: '4.17.20' } })],
      fetchImpl,
    );
    expect(result.failed).toBe(true);
    expect(result.alerts).toEqual([]);
  });

  it('reports failed=true on HTTP 500 (not silent)', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ message: 'oops' }), { status: 500 }),
    ) as unknown as typeof fetch;
    const result = await lookupOsvAdvisories(
      [pkgJson('package.json', { dependencies: { lodash: '4.17.20' } })],
      fetchImpl,
    );
    expect(result.failed).toBe(true);
  });

  it('falls back to a stub alert when the per-id fetch 404s but the batch returned the id', async () => {
    const fetchImpl = makeFetchMock({
      batch: () => ({ results: [{ vulns: [{ id: 'GHSA-orphan' }] }] }),
      vuln: () => null, // 404 from /v1/vulns/{id}
    });
    const result = await lookupOsvAdvisories(
      [pkgJson('package.json', { dependencies: { lodash: '4.17.20' } })],
      fetchImpl,
    );
    expect(result.alerts.length).toBe(1);
    expect(result.alerts[0].id).toBe('GHSA-orphan');
    expect(result.alerts[0].severity).toBe('medium'); // fallback
  });

  it('sorts alerts critical-first so the renderer + Analyst see the highest priority entries up top', async () => {
    const fetchImpl = makeFetchMock({
      batch: () => ({ results: [{ vulns: [{ id: 'GHSA-low' }, { id: 'GHSA-crit' }] }] }),
      vuln: (id) =>
        id === 'GHSA-crit'
          ? { id, summary: 's', database_specific: { severity: 'critical' } }
          : { id, summary: 's', database_specific: { severity: 'low' } },
    });
    const result = await lookupOsvAdvisories(
      [pkgJson('package.json', { dependencies: { lodash: '4.17.20' } })],
      fetchImpl,
    );
    expect(result.alerts.map((a) => a.id)).toEqual(['GHSA-crit', 'GHSA-low']);
  });
});
