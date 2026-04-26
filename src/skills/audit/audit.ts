/**
 * Audit Skill — Handler
 *
 * Two modes (selected by the --analyze flag):
 *
 *   /audit <repo>                          → plan-only (default, zero LLM)
 *   /audit <repo> --analyze                → full Scout + Extractor + Analyst,
 *                                            returns AuditFinding[]
 *
 * --analyze routing:
 *   - Inline-safe (depth=quick + ≤25 files): runs in the Worker.
 *   - Otherwise + TASK_PROCESSOR available + transport=telegram: dispatches
 *     to the DO (mirrors /dossier). Worker returns "🔍 Audit started…" right
 *     away; the DO sends the finished report later.
 *   - Otherwise: returns a clear "audit too large" error.
 *
 * Other flags:
 *   --lens <lens>            narrow to a single lens
 *   --depth quick|standard|deep
 *   --branch <name>
 */

import type { SkillRequest, SkillResult, SkillMeta } from '../types';
import type { AuditFinding, AuditPlan, AuditRun, Depth, Lens, RepoProfile } from './types';
import { MVP_LENSES, findingPriority, isLens, isDepth } from './types';
import { scout, fetchFileContents, parseRepoCoords } from './scout';
import { fileMatchesLens, depthBudget } from './lenses';
import {
  getCachedProfile, cacheProfile,
  cacheAuditRun, getCachedAuditRun,
  getSuppressedIds, addSuppression, removeSuppression,
} from './cache';
import { extractSnippets } from './extractor/extractor';
import { loadGrammar, loadRuntimeWasm } from './grammars/loader';
import { analyzeWithLens } from './analyst/analyst';
import type { SkillTaskRequest, TaskProcessor } from '../../durable-objects/task-processor';

/** Hard inline-execution budget. Beyond this we refuse with a clear message
 *  rather than burn the Worker's 10s wall-clock on a doomed audit. The DO
 *  async dispatch path (slice 3) lifts this. */
const INLINE_MAX_FILES = 25;

export const AUDIT_META: SkillMeta = {
  id: 'audit',
  name: 'Audit',
  description: 'Repo audit — root-cause analysis + corrective + preventive actions, no clone required',
  defaultModel: 'flash',
  subcommands: ['plan', 'run'],
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleAudit(request: SkillRequest): Promise<SkillResult> {
  const start = Date.now();

  // 0. Subcommands that don't take a repo arg — short-circuit before the
  // repo-arg parsing because the text is a runId / runId+findingId.
  if (request.subcommand === 'export') {
    return handleExport(request, start);
  }
  if (request.subcommand === 'suppress' || request.subcommand === 'unsuppress') {
    return handleSuppress(request, start, request.subcommand === 'unsuppress');
  }

  // 1. Parse args
  const repoArg = request.text.trim().split(/\s+/)[0] ?? '';
  if (!repoArg) {
    return errorResult('Please provide a repo. Usage: /audit <owner/repo or URL> [--lens X] [--depth quick|standard|deep] [--branch <name>]');
  }
  const coords = parseRepoCoords(repoArg);
  if (!coords) {
    return errorResult(`Could not parse "${repoArg}" as a GitHub repo. Use owner/repo or a github.com URL.`);
  }

  const lens = parseLensFlag(request.flags.lens);
  if (request.flags.lens && !lens) {
    return errorResult(`Unknown --lens "${request.flags.lens}". Valid: ${MVP_LENSES.join(', ')}.`);
  }
  const lenses: Lens[] = lens ? [lens] : [...MVP_LENSES];

  const depth = parseDepthFlag(request.flags.depth);
  if (request.flags.depth && !depth) {
    return errorResult(`Unknown --depth "${request.flags.depth}". Valid: quick, standard, deep.`);
  }

  const branch = request.flags.branch;

  // 2. Scout — fetch from cache or call GitHub
  const githubToken = request.env.GITHUB_TOKEN;
  let profile: RepoProfile;
  let apiCalls = 0;
  let cachedFromSha: string | undefined;

  // First call always hits the network because we don't yet know the SHA.
  // Subsequent calls in the same run could be cached, but for the v0 plan-only
  // path the Scout is the only stage so we always run it.
  try {
    const result = await scout({ owner: coords.owner, repo: coords.repo, branch, token: githubToken });
    profile = result.profile;
    apiCalls = result.apiCalls;

    // Once we have the SHA, peek the cache — if we have a fresh profile keyed
    // on the same SHA, prefer it (it may have richer manifest content collected
    // in a prior, deeper run). Otherwise persist this one.
    const cached = await getCachedProfile(request.env.NEXUS_KV, profile.owner, profile.repo, profile.sha);
    if (cached && cached.profileHash === profile.profileHash) {
      profile = cached;
      cachedFromSha = profile.sha;
    } else {
      await cacheProfile(request.env.NEXUS_KV, profile);
    }
  } catch (err) {
    return errorResult(`Audit failed at Scout stage: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3. Build the plan — lens-filter + budget estimate
  const plan = buildPlan(profile, lenses, depth ?? 'quick');

  // 4a. Plan-only mode — return immediately.
  const analyzeFlag = request.flags.analyze === 'true' || request.subcommand === 'run';
  if (!analyzeFlag) {
    const body = formatPlan(plan, { cached: !!cachedFromSha, apiCalls });
    return {
      skillId: 'audit',
      kind: 'audit_plan',
      body,
      data: plan,
      telemetry: {
        durationMs: Date.now() - start,
        model: 'none',
        llmCalls: 0,
        toolCalls: apiCalls,
      },
    };
  }

  // 4b. --analyze: decide inline vs DO vs refuse.
  //
  // Inside the DO, runningInDO=true short-circuits the dispatcher and lets
  // us fall through to runFullAudit with the inline budget guard relaxed.
  // From the worker, we either run inline (cheap audits) or dispatch to
  // the DO (long audits) — same pattern as /dossier.
  return dispatchOrInline({ plan, request, apiCallsSoFar: apiCalls, cachedProfile: !!cachedFromSha, start });
}

// ---------------------------------------------------------------------------
// Full Scout → Extractor → Analyst pipeline (inline, no DO yet)
// ---------------------------------------------------------------------------

interface RunFullAuditCtx {
  plan: AuditPlan;
  request: SkillRequest;
  apiCallsSoFar: number;
  cachedProfile: boolean;
  start: number;
}

/**
 * Decide whether an --analyze request runs inline (Worker), gets dispatched
 * to the TaskProcessor DO, or is refused. Mirrors the /dossier pattern.
 */
async function dispatchOrInline(ctx: RunFullAuditCtx): Promise<SkillResult> {
  const { plan, request } = ctx;

  // Compute selected-paths size up-front; used by both the inline-safe check
  // and the DO payload (so the DO doesn't have to re-derive selections).
  const selectedPaths = new Set<string>();
  for (const lens of plan.lenses) {
    for (const p of plan.selections[lens]) selectedPaths.add(p);
  }

  const inlineSafe = plan.depth === 'quick' && selectedPaths.size <= INLINE_MAX_FILES;
  const insideDO = request.context?.runningInDO === true;

  // Already in the DO, or the audit is small — run inline.
  if (insideDO || inlineSafe) {
    return runFullAudit(ctx);
  }

  // Worker side, audit is too big for inline. Try DO dispatch.
  const taskProcessor = request.env.TASK_PROCESSOR as
    | DurableObjectNamespace<TaskProcessor>
    | undefined;
  const hasUsableDO = typeof taskProcessor?.idFromName === 'function'
    && typeof taskProcessor?.get === 'function';

  const telegramToken = request.context?.telegramToken;
  const chatId = request.chatId;
  const canDispatch = hasUsableDO && request.transport === 'telegram' && !!telegramToken && !!chatId;

  if (!canDispatch) {
    return errorResult(
      `Audit too large for inline execution: depth=${plan.depth}, ${selectedPaths.size} files selected (max inline: depth=quick + ${INLINE_MAX_FILES} files).\n` +
      `Larger audits need the TaskProcessor DO + Telegram transport. Use --depth quick + --lens <single-lens> for the inline envelope.`,
    );
  }

  // Dispatch — fire-and-forget; the DO sends the report when ready.
  return dispatchToDO(ctx, taskProcessor!, telegramToken!, chatId!);
}

async function dispatchToDO(
  ctx: RunFullAuditCtx,
  taskProcessor: DurableObjectNamespace<TaskProcessor>,
  telegramToken: string,
  chatId: number,
): Promise<SkillResult> {
  const { plan, request, start } = ctx;
  const taskId = crypto.randomUUID();
  // DO identity is *deterministic* per (user, repo, sha, lenses, depth) so
  // that re-running the same audit hits the same DO instance — enabling
  // dedupe / resume semantics later. The taskId UUID is kept for display
  // and per-run state tracking inside the DO.
  const doId = taskProcessor.idFromName(audit_do_key(request.userId, plan));
  const stub = taskProcessor.get(doId);

  // Strip env from the wire payload — Workers bindings (R2/KV/DO/Fetcher)
  // don't survive JSON serialization. The DO authoritatively rebuilds env
  // from this.doEnv. Sending undefined makes any accidental DO-side use
  // crash loudly instead of silently calling methods on `{}`. (Same lesson
  // we already learned for nexus dispatch.)
  const wireSkillRequest = { ...request, env: undefined as unknown as SkillRequest['env'] };

  const skillTaskRequest: SkillTaskRequest = {
    kind: 'skill',
    taskId,
    chatId,
    userId: request.userId,
    telegramToken,
    skillRequest: wireSkillRequest,
    openrouterKey: request.env.OPENROUTER_API_KEY,
    githubToken: request.env.GITHUB_TOKEN,
    braveSearchKey: request.env.BRAVE_SEARCH_KEY,
    tavilyKey: request.env.TAVILY_API_KEY,
    cloudflareApiToken: request.env.CLOUDFLARE_API_TOKEN,
  };

  let resp: Response;
  try {
    resp = await stub.fetch('https://do/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(skillTaskRequest),
    });
  } catch (err) {
    console.error('[Audit] DO dispatch failed:', err instanceof Error ? err.message : err);
    return errorResult(`Audit dispatch failed: ${err instanceof Error ? err.message : 'unknown error'}`);
  }
  // The DO returns 200 + JSON on accept, anything else is a dispatch failure
  // we MUST surface — otherwise the user sees "Audit started" while the DO
  // never actually started. Read the body defensively (it may be empty).
  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.text()).slice(0, 240); } catch { /* ignore */ }
    return errorResult(`Audit dispatch failed: DO returned ${resp.status}${detail ? ` — ${detail}` : ''}`);
  }

  const { profile } = plan;
  const lensSummary = plan.lenses.length === 1 ? plan.lenses[0] : `${plan.lenses.length} lenses`;
  return {
    skillId: 'audit',
    kind: 'text',
    body: `🔍 Audit started for ${profile.owner}/${profile.repo}@${profile.sha.slice(0, 7)} (${lensSummary}, ${plan.depth}).\n\nResults will arrive in this chat when the analysis completes.`,
    data: { taskId, async: true },
    telemetry: {
      durationMs: Date.now() - start,
      model: request.modelAlias ?? AUDIT_META.defaultModel,
      llmCalls: 0,
      toolCalls: ctx.apiCallsSoFar,
    },
  };
}

/**
 * Deterministic DO key. Same user + repo + SHA + lenses (sorted, normalized)
 * + depth → same DO. Sorting the lenses keeps the key stable regardless of
 * arg order; the SHA pins the audit to a specific commit so a force-pushed
 * branch produces a fresh DO instance.
 *
 * Exposed for testing — the regression test asserts the key is stable
 * across argument-order permutations.
 */
export function audit_do_key(userId: string, plan: AuditPlan): string {
  const lensKey = [...plan.lenses].sort().join(',');
  return `audit:${userId}:${plan.profile.owner}/${plan.profile.repo}@${plan.profile.sha}:${lensKey}:${plan.depth}`;
}

async function runFullAudit(ctx: RunFullAuditCtx): Promise<SkillResult> {
  const { plan, request } = ctx;
  const profile = plan.profile;

  // Union the per-lens selections so we fetch each unique path once.
  const selectedPaths = new Set<string>();
  for (const lens of plan.lenses) {
    for (const p of plan.selections[lens]) selectedPaths.add(p);
  }

  // Defensive backstop on the inline-budget guard. The dispatcher above
  // should already have routed oversize audits to the DO; we hit this branch
  // only for inline-safe runs (Worker) or runningInDO=true runs (DO event,
  // which has 30s of CPU + auto-resume — guard relaxed). If neither holds,
  // refuse rather than burn budget.
  const insideDO = request.context?.runningInDO === true;
  if (!insideDO && (plan.depth !== 'quick' || selectedPaths.size > INLINE_MAX_FILES)) {
    return errorResult(
      `Audit too large for inline execution: depth=${plan.depth}, ${selectedPaths.size} files selected (max inline: depth=quick + ${INLINE_MAX_FILES} files).\n` +
      `Use --depth quick + --lens <single-lens>, or rely on the DO dispatch path.`,
    );
  }

  // Worker-bootstrap gate: --analyze needs the web-tree-sitter runtime WASM.
  // Without it Parser.init fails inside the Worker. We fetch the runtime
  // bytes from R2 (pushed by scripts/upload-audit-grammars.mjs) before any
  // Extractor work happens; if absent, surface a clear "not enabled" message.
  let runtimeWasmBytes: Uint8Array | null = null;
  if (request.env.MOLTBOT_BUCKET) {
    const runtime = await loadRuntimeWasm({ MOLTBOT_BUCKET: request.env.MOLTBOT_BUCKET });
    runtimeWasmBytes = runtime?.bytes ?? null;
  }
  if (!runtimeWasmBytes && !isNodeTestEnv()) {
    return errorResult(
      'Audit analysis is not enabled in this build: tree-sitter runtime WASM is not present in MOLTBOT_BUCKET. ' +
      'Run `npm run audit:upload-grammars` to push it, then retry.',
    );
  }

  // Fetch contents for the selected files (Scout pre-fetched manifests; the
  // Extractor doesn't itself call GitHub — keeps the data flow auditable).
  const fetchResult = selectedPaths.size > 0
    ? await fetchFileContents({
        owner: profile.owner,
        repo: profile.repo,
        ref: profile.sha,
        paths: [...selectedPaths],
        token: request.env.GITHUB_TOKEN,
      })
    : { files: [], apiCalls: 0 };
  const totalApiCalls = ctx.apiCallsSoFar + fetchResult.apiCalls;

  // Validate fetched-file SHA against the tree SHA. A mismatch is rare but
  // possible (symlinks, submodules, ref drift between calls). Skip files
  // that don't agree — the Analyst's evidence-bound contract relies on
  // path+content being internally consistent.
  const treeSha = new Map(profile.tree.map(t => [t.path, t.sha] as const));
  let shaMismatches = 0;
  const contentByPath = new Map<string, string>();
  for (const f of fetchResult.files) {
    if (f.content == null) continue;
    const expected = treeSha.get(f.path);
    if (expected && f.sha && expected !== f.sha) {
      shaMismatches++;
      continue;
    }
    contentByPath.set(f.path, f.content);
  }

  // Run the Extractor once across all selected paths. The grammar loader is
  // supplied via a closure; in Worker production we pass runtimeWasmBytes so
  // bootstrapParser hits the strict mode and fails loudly on misconfig.
  const extractCtx = {
    profile,
    selections: [...selectedPaths]
      .map(p => ({ path: p, content: contentByPath.get(p) ?? '' }))
      .filter(s => s.content.length > 0),
    loadGrammar: (lang: Parameters<typeof loadGrammar>[1]) => loadGrammar(request.env, lang),
    parserBootstrap: runtimeWasmBytes
      ? { runtimeWasmBytes, requireRuntimeWasmBytes: true }
      : undefined, // Node tests fall back to the package's auto-resolution
  };
  const extracted = await extractSnippets(extractCtx);

  // Per-lens Analyst calls. Snippets are partitioned by the lens that asked
  // for the file; manifests + workflow snippets reach every lens because
  // their relevance varies by lens (a Dockerfile is signal for security,
  // deps, perf, …).
  const findings: AuditFinding[] = [];
  let llmCalls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  for (const lens of plan.lenses) {
    const lensPaths = new Set(plan.selections[lens]);
    const lensSnippets = extracted.snippets.filter(s =>
      lensPaths.has(s.path) || s.kind === 'manifest' || s.kind === 'workflow',
    );
    const result = await analyzeWithLens({
      profile,
      snippets: lensSnippets,
      lens,
      env: request.env,
      modelAlias: request.modelAlias,
      defaultModel: AUDIT_META.defaultModel,
    });
    if (result.telemetry.llmCalled) llmCalls++;
    if (result.telemetry.tokens) {
      promptTokens += result.telemetry.tokens.prompt;
      completionTokens += result.telemetry.tokens.completion;
    }
    findings.push(...result.findings);
  }

  // Apply per-repo suppressions. We persist ALL validated findings (so
  // /audit export remains transparent and the user can see what their
  // prior suppression decisions hid), but mark the suppressed ones with
  // `suppressed: true`. The default inline view + the keyboard's top-3
  // filter out suppressed; the export's "Suppressed" section shows them.
  const suppressedIds = await getSuppressedIds(
    request.env.NEXUS_KV, request.userId, profile.owner, profile.repo,
  );
  const annotated = findings
    .filter(f => f.confidence >= 0.5)
    .map(f => suppressedIds.has(f.id) ? { ...f, suppressed: true } : f);
  const suppressedDropped = annotated.filter(f => f.suppressed).length;

  // Sort by priority (severity × confidence). Suppressed findings rank
  // last so any caller that doesn't filter still pushes them to the
  // bottom of any list view.
  const ranked = annotated.sort((a, b) => {
    if (!!a.suppressed !== !!b.suppressed) return a.suppressed ? 1 : -1;
    return findingPriority(b) - findingPriority(a);
  });

  const run: AuditRun = {
    runId: crypto.randomUUID(),
    repo: { owner: profile.owner, name: profile.repo, sha: profile.sha },
    lenses: plan.lenses,
    depth: plan.depth,
    findings: ranked,
    telemetry: {
      durationMs: Date.now() - ctx.start,
      llmCalls,
      tokensIn: promptTokens,
      tokensOut: completionTokens,
      // Crude $ estimate: $0.50 per 1M input + $1.50 per 1M output (mid-range
      // model pricing). Real per-call costs are recorded in the telemetry of
      // each LLM call; this is the user-visible aggregate.
      costUsd: (promptTokens / 1_000_000) * 0.5 + (completionTokens / 1_000_000) * 1.5,
      githubApiCalls: totalApiCalls,
    },
  };

  // Distinguish grammar-unavailable parse errors (R2 missing the grammar
  // for a language we tried to extract) from other parse failures. The
  // former implies "audit coverage was partial — operator should run the
  // grammars uploader"; the latter is a per-file noise event. Surface
  // the missing-grammar set explicitly so users don't read "no defects"
  // as "the code is fine" when the truth is "we couldn't even look".
  const missingGrammars = new Set<string>();
  let otherParseErrors = 0;
  for (const e of extracted.parseErrors) {
    const m = /grammar "(\w+)" unavailable/.exec(e.reason);
    if (m) missingGrammars.add(m[1]);
    else otherParseErrors++;
  }

  // Persist the run for /audit export <runId>. The top-5 view in the
  // Telegram message is bounded; the full report (all findings + full
  // preventive artifacts + RCA prose) lives here. Best-effort: if KV
  // is unavailable, the user just can't `export` later — the inline
  // result still shows the top-5 + run id.
  await cacheAuditRun(request.env.NEXUS_KV, request.userId, run);

  return {
    skillId: 'audit',
    kind: 'audit_run',
    body: formatRun(run, {
      snippetCount: extracted.snippets.length,
      otherParseErrors,
      shaMismatches,
      missingGrammars,
      suppressedDropped,
    }),
    data: run,
    telemetry: {
      durationMs: run.telemetry.durationMs,
      model: request.modelAlias ?? AUDIT_META.defaultModel,
      llmCalls,
      toolCalls: totalApiCalls,
      tokens: { prompt: promptTokens, completion: completionTokens },
    },
  };
}

/**
 * True iff we're running under Vitest (or another explicitly-test runtime).
 *
 * We use this in exactly one place: to permit the inline --analyze path to
 * fall through web-tree-sitter's auto-resolution when MOLTBOT_BUCKET hasn't
 * been populated with the runtime WASM. Production Workers never have these
 * env vars set; this is much narrower than "any Node runtime" — a CLI
 * harness or local Node-based emulator without R2 will now correctly hit
 * the feature gate instead of silently bypassing it.
 */
function isNodeTestEnv(): boolean {
  if (typeof process === 'undefined' || !process.env) return false;
  return Boolean(process.env.VITEST) || process.env.NODE_ENV === 'test';
}

// ---------------------------------------------------------------------------
// Plan construction
// ---------------------------------------------------------------------------

export function buildPlan(profile: RepoProfile, lenses: Lens[], depth: Depth): AuditPlan {
  const budget = depthBudget(depth);
  const selections = {} as Record<Lens, string[]>;
  const notes: string[] = [];

  for (const l of MVP_LENSES) selections[l] = [];

  for (const l of lenses) {
    const candidates = profile.tree
      .filter(t => fileMatchesLens(t, l))
      .sort((a, b) => (b.size ?? 0) - (a.size ?? 0)) // bigger files first as a crude signal
      .slice(0, budget.maxFilesPerLens);
    selections[l] = candidates.map(t => t.path);
    if (candidates.length === 0) {
      notes.push(`No files matched the "${l}" lens — repo may not contain typical ${l} surfaces.`);
    }
  }

  if (profile.codeScanningAlerts.length > 0) {
    const truncatedSuffix = profile.codeScanningAlertsTruncated ? ' (first page only — more may exist)' : '';
    notes.push(`${profile.codeScanningAlerts.length} pre-existing GitHub Code Scanning alerts will be ingested as evidence${truncatedSuffix}.`);
  } else {
    notes.push('No GitHub Code Scanning alerts available (feature disabled or no findings).');
  }

  if (profile.treeTruncated) {
    notes.push('⚠️ GitHub tree response was truncated (>100k entries or >7 MB) — audit coverage is partial. Consider --scope to narrow.');
  }

  if (profile.tree.length === 0) {
    notes.push('Repo tree is empty — nothing to audit.');
  }

  return {
    profile,
    lenses,
    depth,
    selections,
    estimate: {
      llmCalls: budget.maxLlmCalls,
      inputTokens: budget.inputTokenEstimate,
      costUsd: budget.costUsdEstimate,
    },
    notes,
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatPlan(plan: AuditPlan, ctx: { cached: boolean; apiCalls: number }): string {
  const p = plan.profile;
  const lines: string[] = [];
  lines.push(`Audit plan: ${p.owner}/${p.repo}@${p.sha.slice(0, 7)} (${p.defaultBranch})`);
  lines.push(`Stack: ${p.meta.primaryLanguage ?? 'unknown'} • ${p.tree.length} files • ${(p.meta.sizeKb / 1024).toFixed(1)} MiB`);
  if (p.meta.archived) lines.push('⚠️ Repo is archived');
  if (p.meta.private) lines.push('🔒 Repo is private');
  lines.push('');

  lines.push(`Depth: ${plan.depth}`);
  lines.push(`Lenses: ${plan.lenses.join(', ')}`);
  lines.push('');

  lines.push('Selections (files the Extractor would parse):');
  for (const l of plan.lenses) {
    const files = plan.selections[l];
    lines.push(`  ${l} (${files.length}):`);
    for (const f of files.slice(0, 5)) lines.push(`    - ${f}`);
    if (files.length > 5) lines.push(`    … +${files.length - 5} more`);
  }
  lines.push('');

  lines.push('Manifests collected:');
  if (plan.profile.manifests.length === 0) {
    lines.push('  (none of the always-fetch manifests were present)');
  } else {
    for (const m of plan.profile.manifests) {
      lines.push(`  - ${m.path}${m.content == null ? ' (too large, sha-only)' : ''}`);
    }
  }
  lines.push('');

  if (plan.notes.length > 0) {
    lines.push('Notes:');
    for (const n of plan.notes) lines.push(`  • ${n}`);
    lines.push('');
  }

  lines.push(`Estimated cost: ~$${plan.estimate.costUsd.toFixed(2)} • ${plan.estimate.llmCalls} LLM calls • ~${plan.estimate.inputTokens.toLocaleString()} input tokens`);
  lines.push(`GitHub API calls used: ${ctx.apiCalls}${ctx.cached ? ' (profile served from cache)' : ''}`);
  lines.push('');
  lines.push('This is the v0 plan-only output — Extractor + Analyst land in the next slice.');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Run formatting
// ---------------------------------------------------------------------------

interface FormatRunCounts {
  snippetCount: number;
  otherParseErrors: number;
  shaMismatches: number;
  missingGrammars: Set<string>;
  /** How many findings were dropped because they're on the per-repo
   *  suppression list. Surfaced so users see "5 of 8 findings shown
   *  (3 suppressed)" rather than the report silently shrinking. */
  suppressedDropped?: number;
}

function formatRun(run: AuditRun, c: FormatRunCounts): string {
  const lines: string[] = [];
  lines.push(`Audit report: ${run.repo.owner}/${run.repo.name}@${run.repo.sha.slice(0, 7)}`);
  lines.push(`Lenses: ${run.lenses.join(', ')} • depth: ${run.depth} • ${c.snippetCount} snippets analyzed`);
  if (c.missingGrammars.size > 0) {
    const langs = [...c.missingGrammars].sort().join(', ');
    lines.push(`⚠️ Analysis coverage partial: grammar(s) missing for ${langs}. Files in those languages were skipped — run \`npm run audit:upload-grammars\` to enable.`);
  }
  if (c.otherParseErrors > 0) lines.push(`⚠️ ${c.otherParseErrors} file(s) had parse issues`);
  if (c.shaMismatches > 0) lines.push(`⚠️ ${c.shaMismatches} file(s) skipped: fetched SHA disagreed with tree SHA`);
  if (c.suppressedDropped && c.suppressedDropped > 0) {
    lines.push(`🔇 ${c.suppressedDropped} finding(s) suppressed by prior /audit suppress decisions for this repo.`);
  }
  lines.push('');

  // Inline (top-N) view: suppressed findings are excluded.
  const visible = run.findings.filter(f => !f.suppressed);
  if (visible.length === 0) {
    lines.push('No defects found that meet the precision threshold (confidence ≥ 0.5).');
  } else {
    lines.push(`Findings (${visible.length}):`);
    lines.push('');
    // Top-N for the user-facing report; full list stays in the structured data.
    const topN = visible.slice(0, 5);
    for (const f of topN) {
      lines.push(`[${f.severity.toUpperCase()}] ${f.symptom}`);
      lines.push(`  Lens: ${f.lens} • Confidence: ${f.confidence}`);
      lines.push(`  Root cause: ${f.rootCause}`);
      lines.push(`  Fix: ${f.correctiveAction}`);
      lines.push(`  Prevent: ${formatPreventive(f.preventiveAction, run.runId)}`);
      lines.push(`  Evidence: ${f.evidence.map(e => `${e.path}${e.lines ? `:${e.lines}` : ''}`).join(', ')}`);
      lines.push('');
    }
    if (visible.length > topN.length) {
      lines.push(`… +${visible.length - topN.length} more in the full report.`);
      lines.push('');
    }
  }

  const t = run.telemetry;
  lines.push(`Cost: $${t.costUsd.toFixed(2)} • ${t.llmCalls} LLM calls • ${t.tokensIn.toLocaleString()} → ${t.tokensOut.toLocaleString()} tokens • ${t.githubApiCalls} API calls • ${(t.durationMs / 1000).toFixed(1)}s`);
  return lines.join('\n');
}

/**
 * Render a preventive action for the Telegram top-5 view. We keep the
 * top-level brief but preserve the artifact KIND (CI gate vs lint rule
 * vs Semgrep rule, etc.) and the first non-empty line of the artifact —
 * that's usually the most identifying detail (e.g. the rule id, the
 * step name) and lets the user judge relevance without scrolling. Full
 * artifacts live in result.data and are exposed via /audit export
 * (lands with the Distiller slice).
 */
function formatPreventive(prev: { kind: string; detail: string }, runId: string): string {
  const firstLine = prev.detail.split('\n').find(l => l.trim().length > 0)?.trim() ?? '';
  const more = prev.detail.includes('\n') || prev.detail.length > firstLine.length;
  const summary = firstLine.length > 200 ? firstLine.slice(0, 200) + '…' : firstLine;
  const exportHint = more ? ` (full artifact via /audit export ${runId})` : '';
  return `[${prev.kind}] ${summary}${exportHint}`;
}

// ---------------------------------------------------------------------------
// /audit export <runId> — full report retrieval
// ---------------------------------------------------------------------------

/**
 * Strict RFC 4122 UUID regex (versions 1–5). runIds are produced by
 * crypto.randomUUID() (v4), so we accept only the canonical 36-char
 * dashed shape. Loose patterns let typos like "deadbeef" or "--------"
 * through to the KV layer; user-scoped keys neutralized the security
 * impact, but rejecting at the parse boundary is cheaper + clearer.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function handleExport(request: SkillRequest, start: number): Promise<SkillResult> {
  const runId = request.text.trim().split(/\s+/)[0] ?? '';
  if (!runId) {
    return errorResult('Usage: /audit export <runId>');
  }

  if (!UUID_RE.test(runId)) {
    return errorResult(`Not a valid run id: "${runId.slice(0, 80)}"`);
  }

  const run = await getCachedAuditRun(request.env.NEXUS_KV, request.userId, runId);
  if (!run) {
    return errorResult(`No audit run found with id ${runId} (it may have expired — runs are kept for 7 days).`);
  }

  const format = request.flags.format === 'json' ? 'json' : 'markdown';
  if (format === 'json') {
    // JSON export: structured data, machine-readable. No top-N truncation.
    return {
      skillId: 'audit',
      kind: 'text', // rendered as <pre>JSON</pre> on the telegram side
      body: JSON.stringify(run, null, 2),
      data: run,
      telemetry: {
        durationMs: Date.now() - start,
        model: 'none',
        llmCalls: 0,
        toolCalls: 0,
      },
    };
  }

  return {
    skillId: 'audit',
    kind: 'audit_run',
    body: formatRunFull(run),
    data: run,
    telemetry: {
      durationMs: Date.now() - start,
      model: 'none',
      llmCalls: 0,
      toolCalls: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// /audit suppress <runId> <findingId>  +  /audit unsuppress <runId> <findingId>
// ---------------------------------------------------------------------------

async function handleSuppress(
  request: SkillRequest,
  start: number,
  unsuppress: boolean,
): Promise<SkillResult> {
  const verb = unsuppress ? 'unsuppress' : 'suppress';
  const tokens = request.text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    return errorResult(`Usage: /audit ${verb} <runId> <findingId>`);
  }
  const [runId, findingId] = tokens;
  if (!UUID_RE.test(runId)) {
    return errorResult(`Not a valid run id: "${runId.slice(0, 80)}"`);
  }
  // findingId shape comes from validator.ts: `${lens}-${rolling-hash-base36}`.
  // Tight pattern below — rejects anything that doesn't look like one of our
  // own ids (defense against stale/forged callbacks).
  if (!/^[a-z]+-[a-z0-9]+$/.test(findingId)) {
    return errorResult(`Not a valid finding id: "${findingId.slice(0, 80)}"`);
  }

  // Resolve the runId → (owner, repo). The user-scoped KV lookup naturally
  // rejects cross-user attempts (different userId means different key).
  const run = await getCachedAuditRun(request.env.NEXUS_KV, request.userId, runId);
  if (!run) {
    return errorResult(`No audit run found with id ${runId} (it may have expired — runs are kept for 7 days).`);
  }
  // Sanity: the finding must actually exist in this run (active or
  // suppressed). Now that we persist suppressed findings with
  // `suppressed: true`, the user can re-suppress / un-suppress a
  // finding that has been suppressed before (the previous design lost
  // visibility of those — see GPT slice-4c review finding 3). Reject
  // only when the id was never in this run.
  const findingExisted = run.findings.some(f => f.id === findingId);
  if (!findingExisted) {
    return errorResult(`Finding ${findingId} is not part of run ${runId.slice(0, 8)}…. Use /audit export ${runId} to list this run's findings.`);
  }

  if (unsuppress) {
    const r = await removeSuppression(request.env.NEXUS_KV, request.userId, run.repo.owner, run.repo.name, findingId);
    return {
      skillId: 'audit',
      kind: 'text',
      body: r.removed
        ? `🔊 Un-suppressed ${findingId} in ${run.repo.owner}/${run.repo.name}. Future /audit runs on this repo will surface it again. Suppressions remaining for this repo: ${r.total}.`
        : `${findingId} wasn't on the suppression list for ${run.repo.owner}/${run.repo.name}.`,
      data: { removed: r.removed, totalRemaining: r.total },
      telemetry: { durationMs: Date.now() - start, model: 'none', llmCalls: 0, toolCalls: 0 },
    };
  }

  const r = await addSuppression(request.env.NEXUS_KV, request.userId, run.repo.owner, run.repo.name, findingId);
  return {
    skillId: 'audit',
    kind: 'text',
    body: r.added
      ? `🔇 Suppressed ${findingId} in ${run.repo.owner}/${run.repo.name}. Future /audit runs on this repo will skip it (until /audit unsuppress ${runId} ${findingId}). Total suppressed for this repo: ${r.total}.`
      : `${findingId} was already on the suppression list for ${run.repo.owner}/${run.repo.name}. Total suppressed: ${r.total}.`,
    data: { added: r.added, totalSuppressed: r.total },
    telemetry: { durationMs: Date.now() - start, model: 'none', llmCalls: 0, toolCalls: 0 },
  };
}

/**
 * Full report formatter — used by /audit export. Unlike formatRun (top-5
 * + truncated preventive artifacts for the inline Telegram view), this
 * emits every finding with the full preventive artifact verbatim. Caller
 * is the telegram chunker, which splits at the 4 KB boundary.
 */
function formatRunFull(run: AuditRun): string {
  const lines: string[] = [];
  lines.push(`Audit report — full export`);
  lines.push(`Repo: ${run.repo.owner}/${run.repo.name}@${run.repo.sha.slice(0, 7)}`);
  lines.push(`Run id: ${run.runId}`);
  lines.push(`Lenses: ${run.lenses.join(', ')} • depth: ${run.depth}`);
  lines.push('');

  const active = run.findings.filter(f => !f.suppressed);
  const suppressed = run.findings.filter(f => f.suppressed);

  if (active.length === 0) {
    lines.push('No active defects at confidence ≥ 0.5 (precision threshold).');
  } else {
    lines.push(`Findings (${active.length}):`);
    lines.push('');
    active.forEach((f, idx) => appendFinding(lines, f, idx + 1));
  }

  if (suppressed.length > 0) {
    lines.push(`Suppressed findings (${suppressed.length}) — listed for transparency; excluded from the inline view by your prior /audit suppress decisions:`);
    lines.push('');
    suppressed.forEach((f, idx) => appendFinding(lines, f, idx + 1, true));
  }

  const t = run.telemetry;
  lines.push(`Cost: $${t.costUsd.toFixed(2)} • ${t.llmCalls} LLM calls • ${t.tokensIn.toLocaleString()} → ${t.tokensOut.toLocaleString()} tokens • ${t.githubApiCalls} API calls • ${(t.durationMs / 1000).toFixed(1)}s`);
  return lines.join('\n');
}

function appendFinding(lines: string[], f: AuditFinding, n: number, isSuppressed = false): void {
  const tag = isSuppressed ? '🔇' : `${n}.`;
  lines.push(`${tag} [${f.severity.toUpperCase()}] ${f.symptom}${isSuppressed ? '' : ''}`);
  lines.push(`   Lens: ${f.lens} • Confidence: ${f.confidence} • id: ${f.id}`);
  lines.push(`   Root cause: ${f.rootCause}`);
  lines.push(`   Corrective action: ${f.correctiveAction}`);
  lines.push(`   Preventive (${f.preventiveAction.kind}):`);
  for (const ln of f.preventiveAction.detail.split('\n')) {
    lines.push(`     ${ln}`);
  }
  lines.push(`   Evidence:`);
  for (const e of f.evidence) {
    const lineRef = e.lines ? `:${e.lines}` : '';
    lines.push(`     - ${e.path}${lineRef}${e.sha ? ` (sha: ${e.sha.slice(0, 7)})` : ''}`);
    if (e.snippet) {
      for (const ln of e.snippet.split('\n').slice(0, 8)) lines.push(`         ${ln}`);
    }
  }
  lines.push('');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseLensFlag(raw: string | undefined): Lens | null {
  if (!raw) return null;
  return isLens(raw) ? raw : null;
}

function parseDepthFlag(raw: string | undefined): Depth | null {
  if (!raw) return null;
  return isDepth(raw) ? raw : null;
}

function errorResult(message: string): SkillResult {
  return {
    skillId: 'audit',
    kind: 'error',
    body: message,
    telemetry: { durationMs: 0, model: 'none', llmCalls: 0, toolCalls: 0 },
  };
}
