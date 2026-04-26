/**
 * Audit Skill — Analyst prompts (DMAIC scaffold)
 *
 * Per the design doc §10. The shared system fragment enforces evidence-bound
 * findings and the path-enum guard; per-lens fragments add the specific
 * defect class.
 *
 * Hot-prompts: the runtime can override these via R2-backed prompt loading
 * (see src/skills/runtime.ts); the constants here are the bundled fallback.
 */

import type { Lens } from '../types';

// ---------------------------------------------------------------------------
// Shared DMAIC scaffold
// ---------------------------------------------------------------------------

/** System prompt prepended to every Analyst call regardless of lens. */
export const ANALYST_SYSTEM_PROMPT = `You are a senior code auditor. Work in DMAIC order:
DEFINE → MEASURE → ANALYZE → IMPROVE → CONTROL.

Never claim a defect without direct evidence. Every finding MUST cite at
least one snippet from the supplied evidence — by path, line range, and a
short verbatim excerpt. If you cannot ground a claim in supplied evidence,
drop it.

You may ONLY reference paths from the supplied "tree" array. Anything else
is a hallucination and will be rejected.

ANALYZE phase: apply 5-Whys until the root cause is process / design /
config — not merely a bad line of code.

CONTROL phase: every finding with severity >= medium MUST propose ONE
preventive control from this set:
  - "ci"           a CI gate (e.g. workflow yaml step)
  - "lint"         an ESLint / Biome / oxlint rule
  - "semgrep"      a Semgrep rule body
  - "ast-grep"     an ast-grep pattern
  - "dep-policy"   a dependency policy (Dependabot, version pin)
  - "doc"          a doc / ADR paragraph
  - "test-fixture" a regression test
  - "claude-md"    a CLAUDE.md / .cursorrules note for future agents

Provide the EXACT artifact (rule body, workflow yaml, test file) — not a
description of what to do.

Output a single JSON object — no prose, no code fences. Schema:

{
  "findings": [
    {
      "lens": "security" | "deps" | "types" | "tests" | "deadcode" | "perf",
      "severity": "critical" | "high" | "medium" | "low",
      "confidence": 0.25 | 0.5 | 0.75 | 1.0,
      "symptom": "...",            // observable defect
      "rootCause": "...",          // 5-Whys terminus
      "correctiveAction": "...",   // immediate patch description
      "preventiveAction": {
        "kind": "ci" | "lint" | ...,
        "detail": "..."            // exact artifact
      },
      "evidence": [
        { "path": "<from tree>", "lines": "42-58", "snippet": "..." }
      ]
    }
  ]
}

If you find no defects, return { "findings": [] }. Do not invent findings.`;

// ---------------------------------------------------------------------------
// Per-lens user-prompt fragments
// ---------------------------------------------------------------------------

const LENS_FRAGMENTS: Record<Lens, string> = {
  security: `LENS: security.

Look for: hardcoded secrets, unsafe deserialisation, injection vectors
(SQL/command/template), missing input validation, broad CORS, unsafe DOM
(dangerouslySetInnerHTML, eval, Function ctor), missing auth on
mutating endpoints, workflow yaml issues (unpinned actions, broad
permissions, secret exposure), prototype pollution, path traversal.

Skip stylistic nits. If the only evidence is "this looks suspicious" —
drop the finding.`,

  deps: `LENS: deps.

Cross-reference manifests + lockfiles for: known-vulnerable packages
(reference the manifest snippet by path + lines), unpinned versions
on critical paths, abandoned packages still referenced, depcheck-style
unused declared dependencies, missing peer-dep declarations.`,

  types: `LENS: types.

Look for: \`any\` density in public APIs, \`@ts-ignore\` without
justification, missing generics on container types, unsafe type
assertions, \`as unknown as\`, missing strict-mode flags in tsconfig.json.`,

  tests: `LENS: tests.

Look for: source files in src/ with no co-located test, test fixtures
that don't match production data shapes (compare against manifests),
critical paths (auth, payments, migrations) lacking coverage.`,

  deadcode: `LENS: deadcode.

Look for: exported symbols not imported elsewhere, unused dependencies,
unreachable branches, dead conditional config, files never imported
(check the import snippets across the supplied evidence).`,

  perf: `LENS: perf.

Look for: N+1 query patterns, sync I/O in async paths, unbounded loops,
missing memoization on hot React components, large synchronous JSON
parses on hot paths.`,
};

export function lensUserPromptHeader(lens: Lens): string {
  return LENS_FRAGMENTS[lens] ?? `LENS: ${lens}.`;
}

// ---------------------------------------------------------------------------
// Evidence section builder
// ---------------------------------------------------------------------------

/**
 * Build the "EVIDENCE" portion of the user prompt: the path enum, the
 * snippets, and the existing Code Scanning alerts. The Analyst is told
 * to reference paths ONLY from the path enum — anything else fails the
 * post-LLM validator.
 */
export function buildEvidenceBlock(opts: {
  treePathEnum: string[];
  snippets: Array<{
    path: string;
    kind: string;
    name: string;
    startLine: number;
    endLine: number;
    text: string;
    truncated?: boolean;
  }>;
  codeScanningAlerts?: Array<{
    rule: string;
    severity: string;
    description: string;
    path: string;
    lineStart?: number;
  }>;
}): string {
  const lines: string[] = [];

  lines.push('TREE (the only paths you may reference in evidence):');
  for (const p of opts.treePathEnum) lines.push(`  - ${p}`);
  lines.push('');

  if (opts.codeScanningAlerts && opts.codeScanningAlerts.length > 0) {
    lines.push('PRE-EXISTING GITHUB CODE SCANNING ALERTS (free signal — incorporate where relevant):');
    for (const a of opts.codeScanningAlerts) {
      lines.push(`  - ${a.severity.toUpperCase()} ${a.rule} @ ${a.path}${a.lineStart ? `:${a.lineStart}` : ''}: ${a.description}`);
    }
    lines.push('');
  }

  lines.push('SNIPPETS (verbatim excerpts from the tree above):');
  for (const s of opts.snippets) {
    lines.push(`---`);
    lines.push(`path: ${s.path}`);
    lines.push(`kind: ${s.kind}${s.name ? ` (${s.name})` : ''}`);
    lines.push(`lines: ${s.startLine}-${s.endLine}${s.truncated ? ' (truncated)' : ''}`);
    lines.push('```');
    lines.push(s.text);
    lines.push('```');
  }
  lines.push('---');
  lines.push('');
  lines.push('END EVIDENCE.');
  return lines.join('\n');
}
