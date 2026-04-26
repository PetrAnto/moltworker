/**
 * Audit Skill — Analyst response validator tests
 *
 * Exercises both the structural shape checks AND the path-enum guard.
 * The guard is the anti-hallucination boundary the design depends on, so
 * this is a critical test surface.
 */

import { describe, it, expect } from 'vitest';
import { validateAnalystResponse } from './validator';
import type { Lens } from '../types';

const TREE = new Set(['src/auth.ts', 'src/api.ts', 'package.json']);

function validFinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lens: 'security',
    severity: 'high',
    confidence: 0.75,
    symptom: 'Hardcoded API token in auth.ts',
    rootCause: 'Secret literal committed to repo; no pre-commit secret scan in CI',
    correctiveAction: 'Move secret to env var; rotate the leaked token',
    preventiveAction: { kind: 'ci', detail: 'Add gitleaks step to .github/workflows/ci.yml' },
    evidence: [{ path: 'src/auth.ts', lines: '10-12', snippet: "const TOKEN = 'sk_live_…';" }],
    ...overrides,
  };
}

const opts = { treePathEnum: TREE, lens: 'security' as Lens };

describe('validateAnalystResponse — happy path', () => {
  it('returns the finding with a stable id when valid', () => {
    const raw = JSON.stringify({ findings: [validFinding()] });
    const r = validateAnalystResponse(raw, opts);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].lens).toBe('security');
    expect(r.findings[0].severity).toBe('high');
    expect(r.findings[0].id).toMatch(/^security-[a-z0-9]+$/);
    expect(r.issues).toEqual([]);
  });

  it('returns the same id for the same (lens, path, symptom) — reproducibility', () => {
    const raw = JSON.stringify({ findings: [validFinding()] });
    const a = validateAnalystResponse(raw, opts);
    const b = validateAnalystResponse(raw, opts);
    expect(a.findings[0].id).toBe(b.findings[0].id);
  });

  it('marks evidence source as "llm"', () => {
    const r = validateAnalystResponse(JSON.stringify({ findings: [validFinding()] }), opts);
    expect(r.findings[0].evidence[0].source).toBe('llm');
  });
});

describe('validateAnalystResponse — structural failures', () => {
  it('returns empty + json_parse_failed on malformed JSON', () => {
    const r = validateAnalystResponse('{not json', opts);
    expect(r.findings).toEqual([]);
    expect(r.issues[0].kind).toBe('json_parse_failed');
  });

  it('returns empty when top-level is not an object', () => {
    const r = validateAnalystResponse('[]', opts);
    expect(r.issues[0].kind).toBe('top_level_not_object');
  });

  it('returns empty when findings is not an array', () => {
    const r = validateAnalystResponse('{"findings": "nope"}', opts);
    expect(r.issues[0].kind).toBe('findings_not_array');
  });

  it('drops findings with mismatched lens', () => {
    const raw = JSON.stringify({ findings: [validFinding({ lens: 'perf' })] });
    const r = validateAnalystResponse(raw, opts);
    expect(r.findings).toEqual([]);
    expect(r.issues[0]).toMatchObject({ kind: 'finding_dropped', reason: expect.stringContaining('lens mismatch') });
  });

  it('drops findings with invalid severity / confidence / preventiveAction kind', () => {
    for (const bad of [
      { severity: 'urgent' },
      { confidence: 0.9 }, // not in {0.25, 0.5, 0.75, 1.0}
      { preventiveAction: { kind: 'pray', detail: 'hope it works' } },
    ]) {
      const r = validateAnalystResponse(JSON.stringify({ findings: [validFinding(bad)] }), opts);
      expect(r.findings).toEqual([]);
      expect(r.issues[0].kind).toBe('finding_dropped');
    }
  });

  it('drops findings missing required string fields', () => {
    for (const field of ['symptom', 'rootCause', 'correctiveAction']) {
      const r = validateAnalystResponse(JSON.stringify({ findings: [validFinding({ [field]: '' })] }), opts);
      expect(r.findings).toEqual([]);
    }
  });

  it('drops findings with empty preventiveAction.detail', () => {
    const r = validateAnalystResponse(JSON.stringify({
      findings: [validFinding({ preventiveAction: { kind: 'ci', detail: '' } })],
    }), opts);
    expect(r.findings).toEqual([]);
  });
});

describe('validateAnalystResponse — path-enum guard (anti-hallucination)', () => {
  it('strips evidence entries that cite paths not in the tree', () => {
    const raw = JSON.stringify({
      findings: [validFinding({
        evidence: [
          { path: 'src/auth.ts', lines: '10-12', snippet: 'const TOKEN' },     // valid
          { path: 'src/forged.ts', lines: '1-1', snippet: 'never existed' },   // forged
        ],
      })],
    });
    const r = validateAnalystResponse(raw, opts);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].evidence).toHaveLength(1);
    expect(r.findings[0].evidence[0].path).toBe('src/auth.ts');
    expect(r.issues.find(i => i.kind === 'evidence_path_forged')).toMatchObject({
      kind: 'evidence_path_forged', path: 'src/forged.ts',
    });
  });

  it('drops the entire finding when ALL evidence paths are forged', () => {
    const raw = JSON.stringify({
      findings: [validFinding({
        evidence: [
          { path: 'src/forged-1.ts', lines: '1-1', snippet: 'fake' },
          { path: 'src/forged-2.ts', lines: '1-1', snippet: 'also fake' },
        ],
      })],
    });
    const r = validateAnalystResponse(raw, opts);
    expect(r.findings).toEqual([]);
    expect(r.issues.some(i => i.kind === 'finding_left_with_no_evidence')).toBe(true);
  });

  it('drops findings with empty evidence array', () => {
    const raw = JSON.stringify({ findings: [validFinding({ evidence: [] })] });
    const r = validateAnalystResponse(raw, opts);
    expect(r.findings).toEqual([]);
  });

  it('drops findings with no evidence field at all', () => {
    const f = validFinding(); delete (f as { evidence?: unknown }).evidence;
    const r = validateAnalystResponse(JSON.stringify({ findings: [f] }), opts);
    expect(r.findings).toEqual([]);
  });
});

describe('validateAnalystResponse — multi-finding handling', () => {
  it('keeps valid findings and drops invalid ones in the same batch', () => {
    const raw = JSON.stringify({
      findings: [
        validFinding(),
        validFinding({ severity: 'urgent' }), // drop
        validFinding({ symptom: 'Different defect' }),
      ],
    });
    const r = validateAnalystResponse(raw, opts);
    expect(r.findings).toHaveLength(2);
    // Stable ids across findings within the batch
    const ids = r.findings.map(f => f.id);
    expect(new Set(ids).size).toBe(2);
  });
});
