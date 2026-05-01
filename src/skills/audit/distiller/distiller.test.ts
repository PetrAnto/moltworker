/**
 * Audit Skill — Distiller tests
 *
 * Mocks callSkillLLM at the module boundary to verify:
 *   - empty input is a no-op (no LLM call)
 *   - a clean response splices verbatim onto AuditFinding[]
 *   - structural validation errors fall back to ok=false
 *   - id mismatch / count mismatch are rejected (anti-hallucination)
 *   - LLM failures degrade gracefully (ok=false, never throw)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { distillFindings, applyDistilledProse } from './distiller';
import type { AuditFinding } from '../types';
import type { MoltbotEnv } from '../../../types';

vi.mock('../../llm', () => ({
  callSkillLLM: vi.fn(),
  selectSkillModel: vi.fn().mockReturnValue('flash'),
}));

import { callSkillLLM } from '../../llm';
const mockLLM = vi.mocked(callSkillLLM);

const env = { OPENROUTER_API_KEY: 'k' } as unknown as MoltbotEnv;

function mkFinding(id: string, overrides: Partial<AuditFinding> = {}): AuditFinding {
  return {
    id,
    lens: 'security',
    severity: 'high',
    confidence: 0.75,
    symptom: `verbose symptom about ${id} that goes on for a while because the analyst was generous with prose`,
    rootCause: `verbose root cause for ${id}, several clauses long, full of "It appears that…" filler`,
    correctiveAction: `verbose corrective for ${id} with multiple sentences and softening hedge phrases`,
    preventiveAction: { kind: 'lint', detail: 'no-eval rule body' },
    evidence: [{ path: 'src/x.ts', source: 'github' }],
    ...overrides,
  };
}

beforeEach(() => {
  mockLLM.mockReset();
});

describe('distillFindings', () => {
  it('returns ok=true with no LLM call on empty input', async () => {
    const result = await distillFindings({ findings: [], env });
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.telemetry.llmCalled).toBe(false);
    expect(mockLLM).not.toHaveBeenCalled();
  });

  it('round-trips a well-formed compression and reports tokens', async () => {
    mockLLM.mockResolvedValue({
      text: JSON.stringify({
        findings: [
          { id: 'a', symptom: 'sym a', rootCause: 'root a', fix: 'fix a' },
          { id: 'b', symptom: 'sym b', rootCause: 'root b', fix: 'fix b' },
        ],
      }),
      tokens: { prompt: 120, completion: 80 },
    });
    const result = await distillFindings({
      findings: [mkFinding('a'), mkFinding('b')],
      env,
    });
    expect(result.ok).toBe(true);
    expect(result.findings.map((f) => f.symptom)).toEqual(['sym a', 'sym b']);
    expect(result.telemetry.tokens).toEqual({ prompt: 120, completion: 80 });
  });

  it('rejects a response whose finding count does not match the input (anti-hallucination)', async () => {
    mockLLM.mockResolvedValue({
      text: JSON.stringify({
        findings: [{ id: 'a', symptom: 's', rootCause: 'r', fix: 'f' }],
      }),
    });
    const result = await distillFindings({
      findings: [mkFinding('a'), mkFinding('b')],
      env,
    });
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([]);
  });

  it('rejects a response that reorders / renames ids', async () => {
    mockLLM.mockResolvedValue({
      text: JSON.stringify({
        findings: [
          { id: 'b', symptom: 's', rootCause: 'r', fix: 'f' },
          { id: 'a', symptom: 's', rootCause: 'r', fix: 'f' },
        ],
      }),
    });
    const result = await distillFindings({
      findings: [mkFinding('a'), mkFinding('b')],
      env,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects malformed JSON without throwing', async () => {
    mockLLM.mockResolvedValue({ text: 'not json {' });
    const result = await distillFindings({
      findings: [mkFinding('a')],
      env,
    });
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([]);
  });

  it('falls back gracefully when the LLM call throws', async () => {
    mockLLM.mockRejectedValue(new Error('upstream timeout'));
    const result = await distillFindings({
      findings: [mkFinding('a')],
      env,
    });
    expect(result.ok).toBe(false);
    expect(result.telemetry.llmCalled).toBe(true);
  });

  it('caps each compressed field so a runaway LLM cannot blow past the chunk budget', async () => {
    const ridiculous = 'x'.repeat(500);
    mockLLM.mockResolvedValue({
      text: JSON.stringify({
        findings: [{ id: 'a', symptom: ridiculous, rootCause: ridiculous, fix: ridiculous }],
      }),
    });
    const result = await distillFindings({ findings: [mkFinding('a')], env });
    expect(result.ok).toBe(true);
    expect(result.findings[0].symptom.length).toBeLessThanOrEqual(200);
    expect(result.findings[0].rootCause.length).toBeLessThanOrEqual(200);
    expect(result.findings[0].fix.length).toBeLessThanOrEqual(200);
  });
});

describe('applyDistilledProse', () => {
  it('splices distilled fields onto the original findings, preserving severity / evidence / preventive artifact', () => {
    const findings = [mkFinding('a'), mkFinding('b')];
    const distilled = [
      { id: 'a', symptom: 'tight a', rootCause: 'tight root a', fix: 'tight fix a' },
      { id: 'b', symptom: 'tight b', rootCause: 'tight root b', fix: 'tight fix b' },
    ];
    const merged = applyDistilledProse(findings, distilled);
    expect(merged[0].symptom).toBe('tight a');
    expect(merged[0].correctiveAction).toBe('tight fix a');
    expect(merged[0].rootCause).toBe('tight root a');
    expect(merged[0].severity).toBe('high'); // preserved
    expect(merged[0].preventiveAction.detail).toBe('no-eval rule body'); // preserved
    expect(merged[0].evidence).toEqual(findings[0].evidence); // preserved
  });

  it('leaves findings untouched when no distilled match exists (suppressed / bottom-N)', () => {
    const findings = [mkFinding('a'), mkFinding('b')];
    const distilled = [{ id: 'a', symptom: 'tight', rootCause: 'tight', fix: 'tight' }];
    const merged = applyDistilledProse(findings, distilled);
    expect(merged[0].symptom).toBe('tight');
    expect(merged[1].symptom).toBe(findings[1].symptom); // unchanged
  });
});
