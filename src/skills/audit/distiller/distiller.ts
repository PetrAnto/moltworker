/**
 * Audit Skill — Distiller (final-stage compression for Telegram delivery)
 *
 * Per the design doc §4 four-role pipeline (Scout → Extractor → Analyst →
 * Distiller). The Analyst returns structured JSON whose `symptom`,
 * `rootCause`, and `correctiveAction` fields can be verbose. The Distiller
 * runs ONE cheap LLM call (Flash/Haiku-tier) that rewrites the top-N
 * findings into tight Telegram-shaped prose: each finding compressed to a
 * 1-line symptom + 1-line root cause + 1-line action, total output bounded
 * well under Telegram's 4KB chunk limit.
 *
 * Opt-in via `/audit ... --distill`. Default is off so the existing cost
 * profile is preserved for the inline view (which already truncates and
 * has a bounded shape via formatRun). The Distiller is most useful when
 * the Analyst returned long prose — e.g. deep audits with rich RCA — and
 * the user wants the message body squeezed before chunking kicks in.
 *
 * Failure mode: any LLM / parsing error degrades to the input findings
 * unchanged so formatRun's deterministic path renders the report. The
 * Distiller is a polish step, not a correctness step.
 */

import { callSkillLLM, selectSkillModel } from '../../llm';
import type { AuditFinding } from '../types';
import type { MoltbotEnv } from '../../../types';

const DISTILLER_SYSTEM_PROMPT = `You are an audit report distiller. You rewrite verbose
findings into tight Telegram-friendly prose without losing meaning.

Rules:
- Keep findings ranked exactly as supplied. Do NOT reorder or drop any.
- Each finding becomes EXACTLY three short lines:
    "symptom: <≤120 chars, present-tense, observable>"
    "rootCause: <≤120 chars, the underlying systemic cause>"
    "fix: <≤120 chars, the imperative corrective action>"
- Preserve technical specifics (function names, file paths, package names).
  Drop only filler phrasing (e.g. "It appears that…", "The team should…").
- NEVER invent a finding, change severity/lens/id, or contradict the
  supplied evidence. If a field is empty or unclear, return it verbatim
  (don't speculate).
- Return strict JSON: { "findings": [{ "id": "...", "symptom": "...",
  "rootCause": "...", "fix": "..." }] }. No prose, no fences.`;

export interface DistillOptions {
  findings: ReadonlyArray<AuditFinding>;
  env: MoltbotEnv;
  modelAlias?: string;
  defaultModel?: string;
  /** Max time to wait before falling back to undistilled findings. */
  timeoutMs?: number;
}

export interface DistilledFinding {
  id: string;
  symptom: string;
  rootCause: string;
  fix: string;
}

export interface DistillResult {
  /** One distilled-shape entry per input finding, same order. Empty when
   *  the LLM call or parse failed; caller falls back to undistilled. */
  findings: DistilledFinding[];
  /** Distill telemetry — folded into the run's aggregate counters. */
  telemetry: {
    durationMs: number;
    model: string;
    llmCalled: boolean;
    tokens?: { prompt: number; completion: number };
  };
  /** True when distillation succeeded (caller may use the prose);
   *  false when the caller MUST fall back to the deterministic renderer. */
  ok: boolean;
}

/**
 * Run the Distiller. Never throws — returns ok=false on any failure so
 * callers can treat distillation as a best-effort polish.
 */
export async function distillFindings(opts: DistillOptions): Promise<DistillResult> {
  const start = Date.now();
  const model = selectSkillModel(opts.modelAlias, opts.defaultModel ?? 'flash');

  if (opts.findings.length === 0) {
    return {
      findings: [],
      telemetry: { durationMs: 0, model, llmCalled: false },
      ok: true, // empty input is a valid no-op success
    };
  }

  // We only feed the LLM what it needs to compress. Severity / lens /
  // confidence / evidence stay on the AuditFinding object — they're not
  // editable by the Distiller. Sending them would just bloat the prompt.
  const payload = opts.findings.map((f) => ({
    id: f.id,
    severity: f.severity,
    lens: f.lens,
    symptom: f.symptom,
    rootCause: f.rootCause,
    correctiveAction: f.correctiveAction,
  }));

  let text: string;
  let tokens: { prompt: number; completion: number } | undefined;
  try {
    const result = await callSkillLLM({
      systemPrompt: DISTILLER_SYSTEM_PROMPT,
      userPrompt: `FINDINGS:\n${JSON.stringify(payload, null, 2)}`,
      modelAlias: model,
      responseFormat: { type: 'json_object' },
      maxTokens: 800,
      temperature: 0.0, // deterministic compression
      env: opts.env,
      timeoutMs: opts.timeoutMs ?? 15000,
    });
    text = result.text;
    tokens = result.tokens;
  } catch (err) {
    console.warn('[Distiller] LLM call failed:', err instanceof Error ? err.message : err);
    return {
      findings: [],
      telemetry: { durationMs: Date.now() - start, model, llmCalled: true },
      ok: false,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.warn('[Distiller] response was not valid JSON');
    return {
      findings: [],
      telemetry: { durationMs: Date.now() - start, model, llmCalled: true, tokens },
      ok: false,
    };
  }

  const distilled = validateDistilled(parsed, payload.map((p) => p.id));
  if (!distilled) {
    return {
      findings: [],
      telemetry: { durationMs: Date.now() - start, model, llmCalled: true, tokens },
      ok: false,
    };
  }

  return {
    findings: distilled,
    telemetry: { durationMs: Date.now() - start, model, llmCalled: true, tokens },
    ok: true,
  };
}

/**
 * Validate the LLM response: shape, id-coverage, length caps. Returns null
 * on any structural failure so the caller falls back to the deterministic
 * renderer rather than rendering a half-distilled report.
 */
function validateDistilled(raw: unknown, expectedIds: string[]): DistilledFinding[] | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const root = raw as { findings?: unknown };
  if (!Array.isArray(root.findings)) return null;
  if (root.findings.length !== expectedIds.length) return null;

  const out: DistilledFinding[] = [];
  for (let i = 0; i < root.findings.length; i++) {
    const entry = root.findings[i];
    if (typeof entry !== 'object' || entry === null) return null;
    const e = entry as Record<string, unknown>;
    // The id MUST match (same index, same id) — that pins the LLM to the
    // ranked order so we can splice the prose back into the AuditFinding[].
    if (e.id !== expectedIds[i]) return null;
    if (typeof e.symptom !== 'string' || typeof e.rootCause !== 'string' || typeof e.fix !== 'string') {
      return null;
    }
    out.push({
      id: e.id,
      symptom: cap(e.symptom, 200),
      rootCause: cap(e.rootCause, 200),
      fix: cap(e.fix, 200),
    });
  }
  return out;
}

function cap(s: string, max: number): string {
  const trimmed = s.trim();
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max - 1) + '…';
}

/**
 * Splice distilled prose back onto the original AuditFinding[] so the
 * renderer + downstream cache see the same shape they always did. Source
 * of truth (severity, evidence, preventive artifact) is preserved.
 */
export function applyDistilledProse(
  findings: ReadonlyArray<AuditFinding>,
  distilled: ReadonlyArray<DistilledFinding>,
): AuditFinding[] {
  const byId = new Map(distilled.map((d) => [d.id, d] as const));
  return findings.map((f) => {
    const d = byId.get(f.id);
    if (!d) return f;
    return {
      ...f,
      symptom: d.symptom,
      rootCause: d.rootCause,
      correctiveAction: d.fix,
    };
  });
}
