/**
 * Audit Skill — Analyst
 *
 * Per-lens DMAIC pass: takes ExtractedSnippet[] + a lens, calls the LLM with
 * the DMAIC scaffold, validates the response against the path-enum guard,
 * returns AuditFinding[].
 *
 * Multi-lens dispatch is the caller's job — the Analyst does one lens per
 * call. This keeps prompts focused (precision matters: CodeRabbit's top
 * AI-review F1 is ~51%, so we drop low-confidence findings ruthlessly).
 *
 * Token budget: a single Analyst call is bounded by the snippet count the
 * Extractor passed in (capped at depthBudget(depth).maxFilesPerLens *
 * snippets-per-file). The Analyst itself doesn't paginate — if the prompt
 * exceeds maxTokens, the run fails loudly rather than silently truncating.
 */

import { callSkillLLM, selectSkillModel } from '../../llm';
import { ANALYST_SYSTEM_PROMPT, lensUserPromptHeader, buildEvidenceBlock } from './prompts';
import { validateAnalystResponse, type ValidatorIssue } from './validator';
import type { AuditFinding, ExtractedSnippet, Lens, RepoProfile } from '../types';
import type { MoltbotEnv } from '../../../types';
import { sanitizeSnippets, sanitizeCodeScanningAlerts, type SanitizeNotice } from '../sanitize';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface AnalyzeOptions {
  /** Profile from the Scout — provides the path enum. */
  profile: RepoProfile;
  /** Snippets from the Extractor for this lens. */
  snippets: ExtractedSnippet[];
  /** Single lens per call. */
  lens: Lens;
  /** Worker env (provides OPENROUTER_API_KEY etc.). */
  env: MoltbotEnv;
  /** Optional model alias override. */
  modelAlias?: string;
  /** Default model alias if no override. */
  defaultModel?: string;
  /** Optional system prompt override (e.g. R2 hot-prompt). */
  systemPromptOverride?: string;
}

export interface AnalyzeResult {
  findings: AuditFinding[];
  /** Validator issues (paths the LLM forged, malformed entries, etc.).
   *  Surfaced for telemetry — non-empty doesn't mean failure. */
  issues: ValidatorIssue[];
  /**
   * Notices the pre-prompt sanitizer raised on this lens's evidence
   * (snippets + code-scanning alerts). Empty array is the steady state.
   * Returned alongside the count in telemetry so the audit handler can
   * aggregate across lenses and surface samples in the AuditRun
   * record (see AuditRunSanitization in types.ts) — operator visibility
   * matters more than telemetry-only counters.
   */
  sanitizationNotices: SanitizeNotice[];
  telemetry: {
    durationMs: number;
    model: string;
    /** True iff at least one snippet was sent to the LLM (i.e. work happened). */
    llmCalled: boolean;
    tokens?: { prompt: number; completion: number };
    /** Count of injection / role-tag / base64 / zero-width notices the
     *  pre-prompt sanitizer raised on this run's evidence. Mirrors
     *  sanitizationNotices.length above, kept for back-compat with
     *  callers that only read telemetry. */
    sanitizationNotices: number;
  };
}

/**
 * Run the Analyst against a single lens. Returns findings with telemetry +
 * validator issues. Never throws on LLM/validation failures — degrades to
 * an empty-findings result so the handler can keep going with other lenses.
 */
export async function analyzeWithLens(opts: AnalyzeOptions): Promise<AnalyzeResult> {
  const start = Date.now();
  const model = selectSkillModel(opts.modelAlias, opts.defaultModel ?? 'flash');

  // No snippets = no LLM call. Cheaper than a no-op API round-trip.
  if (opts.snippets.length === 0) {
    return {
      findings: [],
      issues: [],
      sanitizationNotices: [],
      telemetry: {
        durationMs: Date.now() - start,
        model,
        llmCalled: false,
        sanitizationNotices: 0,
      },
    };
  }

  // Pre-prompt sanitization. Snippet text and code-scanning-alert
  // descriptions are both untrusted (they come from arbitrary GitHub
  // repos), so we redact obvious prompt-injection markers before they
  // hit the LLM. See src/skills/audit/sanitize.ts for the full ruleset
  // and the conservative-by-default rationale. Notices are aggregated
  // and counted in telemetry; the cleaned text is what enters the
  // evidence block.
  const { snippets: cleanSnippets, notices: snippetNotices } = sanitizeSnippets(opts.snippets);
  const { alerts: cleanAlerts, notices: alertNotices } = sanitizeCodeScanningAlerts(
    opts.profile.codeScanningAlerts ?? [],
  );
  const sanitizationNoticeList = [...snippetNotices, ...alertNotices];
  const sanitizationNotices = sanitizationNoticeList.length;
  if (sanitizationNotices > 0) {
    // One info line per run is enough — operators get the count via
    // telemetry; the log is for spot-debugging when the notice count
    // jumps unexpectedly.
    const summary = [...snippetNotices, ...alertNotices]
      .map((n) => `${n.label}@${n.path ?? '-'}`)
      .slice(0, 5)
      .join(', ');
    console.warn(
      `[Analyst] sanitizer redacted ${sanitizationNotices} item(s) on ${opts.lens} lens: ${summary}` +
        (sanitizationNotices > 5 ? ` (+${sanitizationNotices - 5} more)` : ''),
    );
  }

  const treePathEnum = new Set(opts.profile.tree.map((t) => t.path));
  const userPrompt = [
    lensUserPromptHeader(opts.lens),
    '',
    buildEvidenceBlock({
      treePathEnum: opts.profile.tree.map((t) => t.path),
      snippets: cleanSnippets,
      codeScanningAlerts: cleanAlerts,
    }),
  ].join('\n');

  const systemPrompt = opts.systemPromptOverride ?? ANALYST_SYSTEM_PROMPT;

  let llmText = '';
  let tokens: { prompt: number; completion: number } | undefined;
  try {
    const result = await callSkillLLM({
      systemPrompt,
      userPrompt,
      modelAlias: model,
      responseFormat: { type: 'json_object' },
      // Reproducibility: temperature 0 so the same SHA + same prompt + same
      // model produces the same finding-id hash across reruns.
      temperature: 0,
      env: opts.env,
      // Hard cap per lens: 6 lenses run concurrently; if any one hangs it must
      // not block the others or outlast the DO's 180 s hard-timeout budget.
      timeoutMs: 60_000,
    });
    llmText = result.text;
    tokens = result.tokens;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Analyst] LLM call failed:', message);
    // Distinct from json_parse_failed: this is an upstream/network/auth
    // failure on the model call itself, not a bad JSON response.
    return {
      findings: [],
      issues: [{ kind: 'llm_call_failed', message }],
      sanitizationNotices: sanitizationNoticeList,
      telemetry: {
        durationMs: Date.now() - start,
        model,
        llmCalled: true,
        sanitizationNotices,
      },
    };
  }

  const { findings, issues } = validateAnalystResponse(llmText, {
    treePathEnum,
    lens: opts.lens,
  });

  return {
    findings,
    issues,
    sanitizationNotices: sanitizationNoticeList,
    telemetry: {
      durationMs: Date.now() - start,
      model,
      llmCalled: true,
      tokens,
      sanitizationNotices,
    },
  };
}
