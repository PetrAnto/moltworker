/**
 * Audit Skill — Analyst response validator
 *
 * The LLM emits a JSON object claiming a `findings` array. This module
 * validates the *shape*, then enforces the path-enum guard: every
 * AuditEvidence.path MUST appear in the supplied tree. Anything else is
 * dropped (with a warning) — that's the anti-hallucination boundary.
 *
 * Findings that fail the structural schema are dropped; findings that
 * survive the schema but cite forged paths have those evidence entries
 * stripped, and the finding is dropped if no valid evidence remains.
 */

import { isPlainObject, safeJsonParse } from '../../validators';
import type {
  AuditFinding,
  AuditEvidence,
  Lens,
  Severity,
  Confidence,
  PreventiveKind,
} from '../types';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ValidateOptions {
  /** Authoritative path enum — usually `profile.tree.map(t => t.path)`. */
  treePathEnum: ReadonlySet<string>;
  /** The lens this Analyst run was scoped to. Findings claiming a different
   *  lens are dropped (we don't trust the model to invent lenses). */
  lens: Lens;
}

export interface ValidateResult {
  /** Findings that passed both the schema check and the path-enum guard. */
  findings: AuditFinding[];
  /** Per-finding issues recorded in the order they were processed.
   *  Useful for telemetry + debugging hallucination rates. */
  issues: ValidatorIssue[];
}

export type ValidatorIssue =
  | { kind: 'llm_call_failed'; message: string }
  | { kind: 'json_parse_failed'; raw: string }
  | { kind: 'top_level_not_object' }
  | { kind: 'findings_not_array' }
  | { kind: 'finding_dropped'; index: number; reason: string }
  | { kind: 'evidence_path_forged'; index: number; path: string }
  | { kind: 'finding_left_with_no_evidence'; index: number };

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

const VALID_SEVERITIES: ReadonlySet<Severity> = new Set(['critical', 'high', 'medium', 'low']);
const VALID_CONFIDENCES: ReadonlySet<Confidence> = new Set([0.25, 0.5, 0.75, 1.0]);
const VALID_PREV_KINDS: ReadonlySet<PreventiveKind> = new Set([
  'ci', 'lint', 'semgrep', 'ast-grep', 'dep-policy', 'doc', 'test-fixture', 'claude-md',
]);

export function validateAnalystResponse(
  raw: string,
  opts: ValidateOptions,
): ValidateResult {
  const issues: ValidatorIssue[] = [];

  const parsed = safeJsonParse(raw);
  if (parsed === null) {
    issues.push({ kind: 'json_parse_failed', raw: raw.slice(0, 200) });
    return { findings: [], issues };
  }
  if (!isPlainObject(parsed)) {
    issues.push({ kind: 'top_level_not_object' });
    return { findings: [], issues };
  }
  const findingsRaw = parsed.findings;
  if (!Array.isArray(findingsRaw)) {
    issues.push({ kind: 'findings_not_array' });
    return { findings: [], issues };
  }

  const findings: AuditFinding[] = [];
  for (let i = 0; i < findingsRaw.length; i++) {
    const candidate = findingsRaw[i];
    const validated = validateFinding(candidate, i, opts, issues);
    if (validated) findings.push(validated);
  }
  return { findings, issues };
}

function validateFinding(
  raw: unknown,
  index: number,
  opts: ValidateOptions,
  issues: ValidatorIssue[],
): AuditFinding | null {
  if (!isPlainObject(raw)) {
    issues.push({ kind: 'finding_dropped', index, reason: 'not an object' });
    return null;
  }

  // Lens — must match the requested one.
  if (raw.lens !== opts.lens) {
    issues.push({ kind: 'finding_dropped', index, reason: `lens mismatch (got "${String(raw.lens)}", expected "${opts.lens}")` });
    return null;
  }

  // Severity, confidence
  const severity = raw.severity;
  if (typeof severity !== 'string' || !VALID_SEVERITIES.has(severity as Severity)) {
    issues.push({ kind: 'finding_dropped', index, reason: `invalid severity "${String(severity)}"` });
    return null;
  }
  const confidence = raw.confidence;
  if (typeof confidence !== 'number' || !VALID_CONFIDENCES.has(confidence as Confidence)) {
    issues.push({ kind: 'finding_dropped', index, reason: `invalid confidence "${String(confidence)}"` });
    return null;
  }

  // Required string fields
  for (const field of ['symptom', 'rootCause', 'correctiveAction'] as const) {
    if (typeof raw[field] !== 'string' || (raw[field] as string).length === 0) {
      issues.push({ kind: 'finding_dropped', index, reason: `missing/empty "${field}"` });
      return null;
    }
  }

  // Preventive action
  const prev = raw.preventiveAction;
  if (!isPlainObject(prev) || typeof prev.kind !== 'string' || !VALID_PREV_KINDS.has(prev.kind as PreventiveKind)
      || typeof prev.detail !== 'string' || prev.detail.length === 0) {
    issues.push({ kind: 'finding_dropped', index, reason: 'invalid preventiveAction' });
    return null;
  }

  // Evidence — array, ≥1 entry, every path in the tree enum
  const evidenceRaw = raw.evidence;
  if (!Array.isArray(evidenceRaw) || evidenceRaw.length === 0) {
    issues.push({ kind: 'finding_dropped', index, reason: 'evidence missing or empty' });
    return null;
  }
  const evidence: AuditEvidence[] = [];
  for (const e of evidenceRaw) {
    if (!isPlainObject(e) || typeof e.path !== 'string') continue;
    if (!opts.treePathEnum.has(e.path)) {
      issues.push({ kind: 'evidence_path_forged', index, path: e.path });
      continue;
    }
    evidence.push({
      path: e.path,
      lines: typeof e.lines === 'string' ? e.lines : undefined,
      snippet: typeof e.snippet === 'string' ? e.snippet : undefined,
      source: 'llm',
      sha: typeof e.sha === 'string' ? e.sha : undefined,
    });
  }
  if (evidence.length === 0) {
    issues.push({ kind: 'finding_left_with_no_evidence', index });
    return null;
  }

  // Build the validated finding. id is a stable hash of (lens + path + symptom)
  // for /suppress and dedup; we use a non-cryptographic rolling hash since
  // collisions only matter within a single audit run.
  const id = stableId(opts.lens, evidence[0].path, raw.symptom as string);

  return {
    id,
    lens: opts.lens,
    severity: severity as Severity,
    confidence: confidence as Confidence,
    evidence,
    symptom: raw.symptom as string,
    rootCause: raw.rootCause as string,
    correctiveAction: raw.correctiveAction as string,
    preventiveAction: {
      kind: prev.kind as PreventiveKind,
      detail: prev.detail as string,
    },
    orchestraPatchBrief: typeof raw.orchestraPatchBrief === 'string' ? raw.orchestraPatchBrief : undefined,
  };
}

function stableId(lens: string, path: string, symptom: string): string {
  let h = 5381 >>> 0;
  const seed = `${lens}|${path}|${symptom}`;
  for (let i = 0; i < seed.length; i++) {
    h = ((h * 33) ^ seed.charCodeAt(i)) >>> 0;
  }
  return `${lens}-${h.toString(36)}`;
}
