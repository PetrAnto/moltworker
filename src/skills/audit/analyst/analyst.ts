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
  telemetry: {
    durationMs: number;
    model: string;
    /** True iff at least one snippet was sent to the LLM (i.e. work happened). */
    llmCalled: boolean;
    tokens?: { prompt: number; completion: number };
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
      telemetry: { durationMs: Date.now() - start, model, llmCalled: false },
    };
  }

  const treePathEnum = new Set(opts.profile.tree.map(t => t.path));
  const userPrompt = [
    lensUserPromptHeader(opts.lens),
    '',
    buildEvidenceBlock({
      treePathEnum: opts.profile.tree.map(t => t.path),
      snippets: opts.snippets,
      codeScanningAlerts: opts.profile.codeScanningAlerts,
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
    });
    llmText = result.text;
    tokens = result.tokens;
  } catch (err) {
    console.error('[Analyst] LLM call failed:', err instanceof Error ? err.message : err);
    return {
      findings: [],
      issues: [{ kind: 'json_parse_failed', raw: '' }],
      telemetry: { durationMs: Date.now() - start, model, llmCalled: true },
    };
  }

  const { findings, issues } = validateAnalystResponse(llmText, {
    treePathEnum,
    lens: opts.lens,
  });

  return {
    findings,
    issues,
    telemetry: { durationMs: Date.now() - start, model, llmCalled: true, tokens },
  };
}
