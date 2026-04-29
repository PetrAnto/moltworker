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
import { MVP_LENSES, findingPriority, isLens, isDepth, isFindingId } from './types';
import { scout, fetchFileContents, parseRepoCoords } from './scout';
import { fileMatchesLens, depthBudget } from './lenses';
import {
  getCachedProfile,
  cacheProfile,
  cacheAuditRun,
  getCachedAuditRun,
  getSuppressedIds,
  addSuppression,
  removeSuppression,
  setAuditSubscription,
  getAuditSubscription,
  deleteAuditSubscription,
  listUserSubscriptions,
  linkRunToSubscription,
  type AuditSubscription,
} from './cache';
import { extractSnippets } from './extractor/extractor';
import { loadGrammar, loadRuntimeWasm } from './grammars/loader';
import { getBundledRuntimeWasm } from './extractor/runtime';
import { analyzeWithLens } from './analyst/analyst';
import type { SkillTaskRequest, TaskProcessor } from '../../durable-objects/task-processor';

/** Hard inline-execution budget. Beyond this we refuse with a clear message
 *  rather than burn the Worker's 10s wall-clock on a doomed audit. The DO
 *  async dispatch path (slice 3) lifts this. */
const INLINE_MAX_FILES = 25;

export const AUDIT_META: SkillMeta = {
  id: 'audit',
  name: 'Audit',
  description:
    'Repo audit — root-cause analysis + corrective + preventive actions, no clone required',
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
  if (request.subcommand === 'fix') {
    return handleFix(request, start);
  }
  if (request.subcommand === 'subscribe') {
    return handleSubscribe(request, start);
  }
  if (request.subcommand === 'unsubscribe') {
    return handleUnsubscribe(request, start);
  }
  if (request.subcommand === 'subs') {
    return handleListSubs(request, start);
  }
  if (request.subcommand === 'grammars') {
    return handleGrammars(request, start);
  }

  // 1. Parse args
  const repoArg = request.text.trim().split(/\s+/)[0] ?? '';
  if (!repoArg) {
    return errorResult(
      'Please provide a repo. Usage: /audit <owner/repo or URL> [--lens X] [--depth quick|standard|deep] [--branch <name>]',
    );
  }
  const coords = parseRepoCoords(repoArg);
  if (!coords) {
    return errorResult(
      `Could not parse "${repoArg}" as a GitHub repo. Use owner/repo or a github.com URL.`,
    );
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
    const result = await scout({
      owner: coords.owner,
      repo: coords.repo,
      branch,
      token: githubToken,
    });
    profile = result.profile;
    apiCalls = result.apiCalls;

    // Once we have the SHA, peek the cache — if we have a fresh profile keyed
    // on the same SHA, prefer it (it may have richer manifest content collected
    // in a prior, deeper run). Otherwise persist this one.
    const cached = await getCachedProfile(
      request.env.NEXUS_KV,
      profile.owner,
      profile.repo,
      profile.sha,
    );
    if (cached && cached.profileHash === profile.profileHash) {
      profile = cached;
      cachedFromSha = profile.sha;
    } else {
      await cacheProfile(request.env.NEXUS_KV, profile);
    }
  } catch (err) {
    return errorResult(
      `Audit failed at Scout stage: ${err instanceof Error ? err.message : String(err)}`,
    );
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
  return dispatchOrInline({
    plan,
    request,
    apiCallsSoFar: apiCalls,
    cachedProfile: !!cachedFromSha,
    start,
  });
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

  // Already inside the DO — run directly, no further dispatch.
  if (request.context?.runningInDO === true) {
    return runFullAudit(ctx);
  }

  // Compute selected-paths size up-front; used by both the inline-safe check
  // and the DO payload (so the DO doesn't have to re-derive selections).
  const selectedPaths = new Set<string>();
  for (const lens of plan.lenses) {
    for (const p of plan.selections[lens]) selectedPaths.add(p);
  }

  // Prefer DO dispatch for Telegram transport: even a quick/small audit makes
  // one LLM call per lens (up to 6), which easily exceeds the Worker's 30s
  // wall-clock limit when calls are sequential. The DO has 30s of CPU +
  // auto-resume via alarm, making it the right host for any multi-LLM workflow.
  const taskProcessor = request.env.TASK_PROCESSOR as
    | DurableObjectNamespace<TaskProcessor>
    | undefined;
  const hasUsableDO =
    typeof taskProcessor?.idFromName === 'function' && typeof taskProcessor?.get === 'function';

  const telegramToken = request.context?.telegramToken;
  const chatId = request.chatId;
  const canDispatch =
    hasUsableDO && request.transport === 'telegram' && !!telegramToken && !!chatId;

  if (canDispatch) {
    return dispatchToDO(ctx, taskProcessor!, telegramToken!, chatId!);
  }

  // Non-Telegram transport (simulate endpoint, tests) — run inline if within budget.
  const inlineSafe = plan.depth === 'quick' && selectedPaths.size <= INLINE_MAX_FILES;
  if (inlineSafe) {
    return runFullAudit(ctx);
  }

  return errorResult(
    `Audit too large for inline execution: depth=${plan.depth}, ${selectedPaths.size} files selected (max inline: depth=quick + ${INLINE_MAX_FILES} files).\n` +
      `Larger audits need the TaskProcessor DO + Telegram transport. Use --depth quick + --lens <single-lens> for the inline envelope.`,
  );
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
    return errorResult(
      `Audit dispatch failed: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
  }
  // The DO returns 200 + JSON on accept, anything else is a dispatch failure
  // we MUST surface — otherwise the user sees "Audit started" while the DO
  // never actually started. Read the body defensively (it may be empty).
  if (!resp.ok) {
    let detail = '';
    try {
      detail = (await resp.text()).slice(0, 240);
    } catch {
      /* ignore */
    }
    return errorResult(
      `Audit dispatch failed: DO returned ${resp.status}${detail ? ` — ${detail}` : ''}`,
    );
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
  // Two-tier resolution (closes design-doc slice 5 / cold-start
  // resilience):
  //   1. R2 first — `npm run audit:upload-grammars` writes a manifest +
  //      runtime entry. Allows hot-uploading a new web-tree-sitter
  //      version without a Worker redeploy.
  //   2. Bundled fallback — `npm run audit:sync-runtime` regenerates
  //      a base64-encoded copy committed in source. No hard dependency
  //      on R2 being warm at cold-start; the runtime is always
  //      available as long as the deploy succeeded.
  // Both paths SHA-verify the bytes before use.
  let runtimeWasmBytes: Uint8Array | null = null;
  let runtimeSource: 'r2' | 'bundled' | null = null;
  let r2RuntimeFailureReason: string | null = null;
  if (request.env.MOLTBOT_BUCKET) {
    const r2 = await loadRuntimeWasm({ MOLTBOT_BUCKET: request.env.MOLTBOT_BUCKET });
    if (r2.ok) {
      runtimeWasmBytes = r2.bytes;
      runtimeSource = 'r2';
    } else if (
      r2.reason !== 'no_bucket' &&
      r2.reason !== 'no_manifest' &&
      r2.reason !== 'missing_runtime'
    ) {
      // 'no_bucket' / 'no_manifest' / 'missing_runtime' are routine
      // — the operator simply hasn't run audit:upload-grammars. The
      // remaining failure modes (sha_mismatch, oversize_*, missing_object)
      // mean the operator pushed something but it's broken — surface
      // that distinct case so they can fix R2 instead of wondering
      // why "runtime: bundled" appears after a successful upload.
      r2RuntimeFailureReason = r2.reason;
    }
  }
  if (!runtimeWasmBytes) {
    const bundled = await getBundledRuntimeWasm();
    if (bundled) {
      runtimeWasmBytes = bundled.bytes;
      runtimeSource = 'bundled';
    }
  }
  if (!runtimeWasmBytes && !isNodeTestEnv()) {
    return errorResult(
      'Audit analysis is not enabled in this build: tree-sitter runtime WASM is not present in either MOLTBOT_BUCKET or the bundled fallback. ' +
        'Run `npm run audit:sync-runtime && npm run audit:upload-grammars` to populate both.',
    );
  }

  // Fetch contents for the selected files (Scout pre-fetched manifests; the
  // Extractor doesn't itself call GitHub — keeps the data flow auditable).
  const fetchResult =
    selectedPaths.size > 0
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
  const treeSha = new Map(profile.tree.map((t) => [t.path, t.sha] as const));
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
      .map((p) => ({ path: p, content: contentByPath.get(p) ?? '' }))
      .filter((s) => s.content.length > 0),
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
  // Run all lens LLM calls in parallel — each lens is independent (no shared
  // mutable state). Sequential execution (one per ~30–45 s) would exceed the
  // 180 s DO hard-timeout for the common 6-lens case; parallel execution
  // completes in the time of the single slowest lens (~45 s).
  const lensResults = await Promise.allSettled(
    plan.lenses.map((lens) => {
      const lensPaths = new Set(plan.selections[lens]);
      const lensSnippets = extracted.snippets.filter(
        (s) => lensPaths.has(s.path) || s.kind === 'manifest' || s.kind === 'workflow',
      );
      return analyzeWithLens({
        profile,
        snippets: lensSnippets,
        lens,
        env: request.env,
        modelAlias: request.modelAlias,
        defaultModel: AUDIT_META.defaultModel,
      });
    }),
  );

  const findings: AuditFinding[] = [];
  let llmCalls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  // Aggregate sanitizer notices across lenses so the run record can
  // surface "the pre-prompt pre-pass redacted N item(s)" — see
  // AuditRunSanitization in types.ts. Notices include path attribution
  // so the operator can see where injection attempts came from, not
  // just a counter on telemetry.
  const allSanitizationNotices: import('./sanitize').SanitizeNotice[] = [];
  for (const [i, settled] of lensResults.entries()) {
    if (settled.status === 'rejected') {
      console.error(`[Audit] lens ${plan.lenses[i]} failed:`, settled.reason);
      continue;
    }
    const result = settled.value;
    if (result.telemetry.llmCalled) llmCalls++;
    if (result.telemetry.tokens) {
      promptTokens += result.telemetry.tokens.prompt;
      completionTokens += result.telemetry.tokens.completion;
    }
    findings.push(...result.findings);
    if (result.sanitizationNotices.length > 0) {
      allSanitizationNotices.push(...result.sanitizationNotices);
    }
  }

  // Apply per-repo suppressions. We persist ALL validated findings (so
  // /audit export remains transparent and the user can see what their
  // prior suppression decisions hid), but mark the suppressed ones with
  // `suppressed: true`. The default inline view + the keyboard's top-3
  // filter out suppressed; the export's "Suppressed" section shows them.
  const suppression = await getSuppressedIds(
    request.env.NEXUS_KV,
    request.userId,
    profile.owner,
    profile.repo,
  );
  const annotated = findings
    .filter((f) => f.confidence >= 0.5)
    .map((f) => (suppression.ids.has(f.id) ? { ...f, suppressed: true } : f));
  const suppressedDropped = annotated.filter((f) => f.suppressed).length;

  // Sort by priority (severity × confidence). Suppressed findings rank
  // last so any caller that doesn't filter still pushes them to the
  // bottom of any list view.
  const ranked = annotated.sort((a, b) => {
    if (!!a.suppressed !== !!b.suppressed) return a.suppressed ? 1 : -1;
    return findingPriority(b) - findingPriority(a);
  });

  // Build the sanitization summary for the run record. Cap samples at 5
  // to keep the persisted record bounded under adversarial inputs (a
  // hostile repo could plant thousands of injection markers; the count
  // captures everything but we only show a few representative samples).
  const sanitization =
    allSanitizationNotices.length > 0
      ? {
          count: allSanitizationNotices.length,
          // Dedup by (kind, label, path) so a snippet with the same marker
          // repeated 50 times shows once. Order preserved → first occurrence
          // wins, which biases samples toward earlier-scanned files.
          samples: dedupSanitizationSamples(allSanitizationNotices).slice(0, 5),
        }
      : undefined;

  const run: AuditRun = {
    runId: crypto.randomUUID(),
    repo: { owner: profile.owner, name: profile.repo, sha: profile.sha },
    lenses: plan.lenses,
    depth: plan.depth,
    findings: ranked,
    sanitization,
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
  const runCached = await cacheAuditRun(request.env.NEXUS_KV, request.userId, run);

  // Only update the subscription's lastRunId when the run was actually
  // persisted. Otherwise we'd leave the sub pointing at a runId that
  // nothing can resolve — bad for the admin tab and for /audit export.
  // The cron's lastTaskId is independent and stamped earlier, so a
  // failed cache here still leaves a debuggable trail.
  if (runCached) {
    await linkRunToSubscription(
      request.env.NEXUS_KV,
      request.userId,
      profile.owner,
      profile.repo,
      run.runId,
    );
  }

  return {
    skillId: 'audit',
    kind: 'audit_run',
    body: formatRun(run, {
      snippetCount: extracted.snippets.length,
      otherParseErrors,
      shaMismatches,
      missingGrammars,
      suppressedDropped,
      suppressionReadError: suppression.error,
      runtimeSource,
      r2RuntimeFailureReason,
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
      .filter((t) => fileMatchesLens(t, l))
      .sort((a, b) => (b.size ?? 0) - (a.size ?? 0)) // bigger files first as a crude signal
      .slice(0, budget.maxFilesPerLens);
    selections[l] = candidates.map((t) => t.path);
    if (candidates.length === 0) {
      notes.push(`No files matched the "${l}" lens — repo may not contain typical ${l} surfaces.`);
    }
  }

  if (profile.codeScanningAlerts.length > 0) {
    const truncatedSuffix = profile.codeScanningAlertsTruncated
      ? ' (first page only — more may exist)'
      : '';
    notes.push(
      `${profile.codeScanningAlerts.length} pre-existing GitHub Code Scanning alerts will be ingested as evidence${truncatedSuffix}.`,
    );
  } else {
    notes.push('No GitHub Code Scanning alerts available (feature disabled or no findings).');
  }

  if (profile.treeTruncated) {
    notes.push(
      '⚠️ GitHub tree response was truncated (>100k entries or >7 MB) — audit coverage is partial. Consider --scope to narrow.',
    );
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
  lines.push(
    `Stack: ${p.meta.primaryLanguage ?? 'unknown'} • ${p.tree.length} files • ${(p.meta.sizeKb / 1024).toFixed(1)} MiB`,
  );
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

  lines.push(
    `Estimated cost: ~$${plan.estimate.costUsd.toFixed(2)} • ${plan.estimate.llmCalls} LLM calls • ~${plan.estimate.inputTokens.toLocaleString()} input tokens`,
  );
  lines.push(
    `GitHub API calls used: ${ctx.apiCalls}${ctx.cached ? ' (profile served from cache)' : ''}`,
  );
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
  /** Non-null when the suppression-list KV read failed. Surfaced as a
   *  warning so users know previously-suppressed findings may be
   *  re-appearing in this run rather than the report silently fail-
   *  opening. Closes GPT slice-4c review (PR 511) follow-up. */
  suppressionReadError?: string | null;
  /** Which path supplied the tree-sitter runtime WASM:
   *    'r2'      — hot-uploaded version from MOLTBOT_BUCKET (preferred)
   *    'bundled' — committed-into-source fallback (cold-start resilient)
   *    null      — neither available (only possible in Node test mode) */
  runtimeSource?: 'r2' | 'bundled' | null;
  /** Non-null when the runtime came from `bundled` because the R2
   *  runtime was configured but failed verification (sha_mismatch,
   *  oversize_*, missing_object). Surfaced as a discrete warning so
   *  operators can tell "R2 unconfigured" (silent) apart from "R2
   *  configured but broken" (loud). Routine cases (no_bucket /
   *  no_manifest / missing_runtime) deliberately don't trigger this. */
  r2RuntimeFailureReason?: string | null;
}

function formatRun(run: AuditRun, c: FormatRunCounts): string {
  const lines: string[] = [];
  lines.push(`Audit report: ${run.repo.owner}/${run.repo.name}@${run.repo.sha.slice(0, 7)}`);
  const runtimeNote = c.runtimeSource ? ` • runtime: ${c.runtimeSource}` : '';
  lines.push(
    `Lenses: ${run.lenses.join(', ')} • depth: ${run.depth} • ${c.snippetCount} snippets analyzed${runtimeNote}`,
  );
  if (c.r2RuntimeFailureReason) {
    lines.push(
      `⚠️ R2 runtime unavailable: ${c.r2RuntimeFailureReason}. Used the bundled fallback. Run \`npm run audit:upload-grammars\` to fix the R2 runtime entry.`,
    );
  }
  if (c.missingGrammars.size > 0) {
    const langs = [...c.missingGrammars].sort().join(', ');
    lines.push(
      `⚠️ Analysis coverage partial: grammar(s) missing for ${langs}. Files in those languages were skipped — run \`npm run audit:upload-grammars\` to enable.`,
    );
  }
  if (c.otherParseErrors > 0) lines.push(`⚠️ ${c.otherParseErrors} file(s) had parse issues`);
  if (c.shaMismatches > 0)
    lines.push(`⚠️ ${c.shaMismatches} file(s) skipped: fetched SHA disagreed with tree SHA`);
  if (c.suppressedDropped && c.suppressedDropped > 0) {
    lines.push(
      `🔇 ${c.suppressedDropped} finding(s) suppressed by prior /audit suppress decisions for this repo.`,
    );
  }
  if (c.suppressionReadError) {
    lines.push(
      `⚠️ Suppression list could not be read (${c.suppressionReadError.slice(0, 120)}); previously suppressed findings may appear in this report. Retry to re-apply your suppressions.`,
    );
  }
  lines.push('');

  // Inline (top-N) view: suppressed findings are excluded.
  const visible = run.findings.filter((f) => !f.suppressed);
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
      lines.push(
        `  Evidence: ${f.evidence.map((e) => `${e.path}${e.lines ? `:${e.lines}` : ''}`).join(', ')}`,
      );
      lines.push('');
    }
    if (visible.length > topN.length) {
      lines.push(`… +${visible.length - topN.length} more in the full report.`);
      lines.push('');
    }
  }

  appendSanitizationSummary(lines, run.sanitization);

  const t = run.telemetry;
  lines.push(
    `Cost: $${t.costUsd.toFixed(2)} • ${t.llmCalls} LLM calls • ${t.tokensIn.toLocaleString()} → ${t.tokensOut.toLocaleString()} tokens • ${t.githubApiCalls} API calls • ${(t.durationMs / 1000).toFixed(1)}s`,
  );
  return lines.join('\n');
}

/**
 * Render the pre-prompt sanitizer's summary into a runs body. Shared by
 * formatRun (Telegram top-5 view) and formatRunFull (/audit export) so
 * the operator sees the same masking summary in both places. Silent
 * when no notices were raised — the steady-state run report has no
 * extra noise.
 */
function appendSanitizationSummary(lines: string[], s: AuditRun['sanitization']): void {
  if (!s || s.count === 0) return;
  // Wording matters: a single source occurrence (e.g. an
  // "IGNORE PREVIOUS INSTRUCTIONS" comment) can be redacted multiple
  // times because the same snippet feeds the Analyst across multiple
  // lenses (manifests + workflows reach every lens). The count is
  // therefore "across lens evidence blocks", not "unique source
  // occurrences" — making that explicit avoids confusion when an
  // operator sees a count larger than the number of suspicious files.
  lines.push(`🛡️ Pre-prompt sanitizer redacted ${s.count} item(s) across lens evidence blocks:`);
  for (const sample of s.samples) {
    const where = sample.path ? ` @ ${sample.path}` : '';
    lines.push(`  - ${sample.label}${where}`);
  }
  if (s.count > s.samples.length) {
    lines.push(`  … +${s.count - s.samples.length} more (samples capped to ${s.samples.length}).`);
  }
  lines.push('');
}

/**
 * De-duplicate sanitizer notices by (kind, label, path) so a single
 * marker repeated many times in one file shows up once. Order is
 * preserved so the first-seen occurrences (typically earlier in the
 * scan, i.e. higher in the directory) become the samples.
 */
function dedupSanitizationSamples(
  notices: ReadonlyArray<{ kind: string; label: string; path?: string }>,
): Array<{ kind: string; label: string; path?: string }> {
  const seen = new Set<string>();
  const out: Array<{ kind: string; label: string; path?: string }> = [];
  for (const n of notices) {
    const key = `${n.kind}|${n.label}|${n.path ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: n.kind, label: n.label, path: n.path });
  }
  return out;
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
  const firstLine =
    prev.detail
      .split('\n')
      .find((l) => l.trim().length > 0)
      ?.trim() ?? '';
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
    return errorResult(
      `No audit run found with id ${runId} (it may have expired — runs are kept for 7 days).`,
    );
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
// /audit fix <runId> <findingId>  →  Orchestra hand-off
// ---------------------------------------------------------------------------

/**
 * Build a clear, self-contained orchestra task description from an audit
 * finding. Pure function — same input → same output (reproducibility),
 * shared by the /audit fix slash-command path and the audit:fix callback
 * auto-dispatch path so both produce identical orchestra dispatches.
 */
export function buildOrchestraTask(run: AuditRun, finding: AuditFinding): string {
  const { repo } = run;
  const lines: string[] = [];
  lines.push(`Fix audit finding in ${repo.owner}/${repo.name}@${repo.sha.slice(0, 7)}.`);
  lines.push('');
  lines.push(
    `Severity: ${finding.severity} • Lens: ${finding.lens} • Confidence: ${finding.confidence}`,
  );
  lines.push(`Symptom: ${finding.symptom}`);
  lines.push(`Root cause: ${finding.rootCause}`);
  lines.push('');
  lines.push('Required corrective action:');
  lines.push(`  ${finding.correctiveAction}`);
  lines.push('');
  lines.push(`Preventive control to add (${finding.preventiveAction.kind}):`);
  for (const ln of finding.preventiveAction.detail.split('\n')) {
    lines.push(`  ${ln}`);
  }
  lines.push('');
  lines.push('Evidence:');
  for (const e of finding.evidence) {
    const lineRef = e.lines ? `:${e.lines}` : '';
    lines.push(`  - ${e.path}${lineRef}${e.sha ? ` (sha ${e.sha.slice(0, 7)})` : ''}`);
    if (e.snippet) {
      // First line of the snippet is the most identifying — keep the
      // orchestra prompt tight.
      const firstLine =
        e.snippet
          .split('\n')
          .find((s) => s.trim().length > 0)
          ?.trim() ?? '';
      if (firstLine) lines.push(`    ${firstLine.slice(0, 200)}`);
    }
  }
  if (finding.orchestraPatchBrief) {
    lines.push('');
    lines.push('Additional context:');
    lines.push(`  ${finding.orchestraPatchBrief}`);
  }
  // Conservative scope guard. Without these explicit constraints the
  // orchestra LLM may helpfully refactor neighboring code, force-push to
  // main, or merge silently — none of which are appropriate for an
  // automated audit hand-off where the source finding came from another
  // LLM upstream. Closes GPT slice-4d review finding 3.
  lines.push('');
  lines.push('Constraints:');
  lines.push(
    '  - Work on a fresh branch and open a PR; never push directly to main / default branch.',
  );
  lines.push('  - Keep the patch minimal and scoped strictly to this finding.');
  lines.push(
    '  - Do not refactor unrelated code, reformat unaffected files, or change public APIs unless the corrective action explicitly requires it.',
  );
  lines.push(
    '  - Add or update tests / CI controls for the preventive action above; do not skip the preventive half.',
  );
  lines.push(
    '  - Cite this audit run id and finding id in the PR description so a follow-up audit can mark the finding fixed.',
  );
  lines.push(
    '  - If the corrective action turns out to be wrong (root cause was misdiagnosed), STOP and reply with what you found instead of pushing speculative fixes.',
  );
  lines.push('');
  lines.push(
    `Audit run: ${run.runId}, finding id: ${finding.id} (cite both in the PR description so /audit can mark this finding fixed on the next run).`,
  );
  return lines.join('\n');
}

/**
 * Validate + resolve + build for the /audit fix path. Used by both the
 * slash-command handler (which surfaces the dispatch text to the user)
 * and the inline-keyboard callback (which auto-dispatches /orch run).
 *
 * Returns a discriminated union so the caller can pattern-match:
 * `ok=true` carries the run + finding + orchestra task text; `ok=false`
 * carries a user-facing error string.
 */
export type FixResolution =
  | { ok: true; run: AuditRun; finding: AuditFinding; taskText: string }
  | { ok: false; error: string };

export async function resolveFix(
  kv: KVNamespace | undefined,
  userId: string,
  runId: string,
  findingId: string,
): Promise<FixResolution> {
  if (!UUID_RE.test(runId)) {
    return { ok: false, error: `Not a valid run id: "${runId.slice(0, 80)}"` };
  }
  if (!isFindingId(findingId)) {
    return { ok: false, error: `Not a valid finding id: "${findingId.slice(0, 80)}"` };
  }
  const run = await getCachedAuditRun(kv, userId, runId);
  if (!run) {
    return {
      ok: false,
      error: `No audit run found with id ${runId} (it may have expired — runs are kept for 7 days).`,
    };
  }
  const finding = run.findings.find((f) => f.id === findingId);
  if (!finding) {
    return {
      ok: false,
      error: `Finding ${findingId} is not part of run ${runId.slice(0, 8)}…. Use /audit export ${runId} to list this run's findings.`,
    };
  }
  return { ok: true, run, finding, taskText: buildOrchestraTask(run, finding) };
}

/**
 * Short user-facing summary of a pending fix dispatch — what the inline
 * "Prepare fix" callback shows above the Confirm/Cancel keyboard. Keeps
 * the message tight (Telegram quotes the full /orch run … prompt would
 * be both noisy and easy to misread before tapping Confirm). The full
 * task text still lands at orchestra; this is just the human review.
 */
export function buildFixSummary(run: AuditRun, finding: AuditFinding): string {
  const lines: string[] = [];
  lines.push(`🔧 <b>Orchestra fix prepared</b>`);
  lines.push('');
  lines.push(
    `<b>Repo:</b> ${escapeHtmlSafe(run.repo.owner)}/${escapeHtmlSafe(run.repo.name)}@${run.repo.sha.slice(0, 7)}`,
  );
  lines.push(
    `<b>Severity:</b> ${finding.severity.toUpperCase()} • <b>Lens:</b> ${finding.lens} • <b>Confidence:</b> ${finding.confidence}`,
  );
  lines.push(`<b>Symptom:</b> ${escapeHtmlSafe(finding.symptom)}`);
  lines.push(`<b>Fix:</b> ${escapeHtmlSafe(finding.correctiveAction)}`);
  lines.push(
    `<b>Preventive:</b> [${finding.preventiveAction.kind}] ${escapeHtmlSafe(
      finding.preventiveAction.detail
        .split('\n')
        .find((l) => l.trim().length > 0)
        ?.trim()
        .slice(0, 160) ?? '',
    )}`,
  );
  lines.push('');
  lines.push(
    `Tap <b>✅ Dispatch fix</b> to send this to orchestra (it will open a PR; the task includes a "do not refactor unrelated code" constraint).`,
  );
  lines.push(`Tap <b>❌ Cancel</b> to dismiss without dispatching.`);
  return lines.join('\n');
}

function escapeHtmlSafe(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function handleFix(request: SkillRequest, start: number): Promise<SkillResult> {
  const tokens = request.text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    return errorResult('Usage: /audit fix <runId> <findingId>');
  }
  const [runId, findingId] = tokens;
  const r = await resolveFix(request.env.NEXUS_KV, request.userId, runId, findingId);
  if (!r.ok) return errorResult(r.error);

  // Slash-command path: surface the orchestra dispatch command so the user
  // can review/edit before running it. The inline-keyboard callback path
  // (handler.ts case 'audit' / sub === 'fix') uses resolveFix directly and
  // dispatches /orch run automatically without this manual step.
  return {
    skillId: 'audit',
    kind: 'text',
    body:
      `🔧 Orchestra task ready for finding ${r.finding.id} in ${r.run.repo.owner}/${r.run.repo.name}.\n\n` +
      `Dispatch with:\n\n/orch run ${r.taskText}\n\n` +
      `Or click the 🔧 Fix button on the original audit message to auto-dispatch.`,
    data: { runId: r.run.runId, findingId: r.finding.id, taskText: r.taskText },
    telemetry: { durationMs: Date.now() - start, model: 'none', llmCalls: 0, toolCalls: 0 },
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
  // Validator lives in types.ts (FINDING_ID_RE) so audit.ts, api.ts, and any
  // future caller share one definition — defense against stale/forged callbacks.
  if (!isFindingId(findingId)) {
    return errorResult(`Not a valid finding id: "${findingId.slice(0, 80)}"`);
  }

  // Resolve the runId → (owner, repo). The user-scoped KV lookup naturally
  // rejects cross-user attempts (different userId means different key).
  const run = await getCachedAuditRun(request.env.NEXUS_KV, request.userId, runId);
  if (!run) {
    return errorResult(
      `No audit run found with id ${runId} (it may have expired — runs are kept for 7 days).`,
    );
  }
  // Sanity: the finding must actually exist in this run (active or
  // suppressed). Now that we persist suppressed findings with
  // `suppressed: true`, the user can re-suppress / un-suppress a
  // finding that has been suppressed before (the previous design lost
  // visibility of those — see GPT slice-4c review finding 3). Reject
  // only when the id was never in this run.
  const findingExisted = run.findings.some((f) => f.id === findingId);
  if (!findingExisted) {
    return errorResult(
      `Finding ${findingId} is not part of run ${runId.slice(0, 8)}…. Use /audit export ${runId} to list this run's findings.`,
    );
  }

  if (unsuppress) {
    const r = await removeSuppression(
      request.env.NEXUS_KV,
      request.userId,
      run.repo.owner,
      run.repo.name,
      findingId,
    );
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

  const r = await addSuppression(
    request.env.NEXUS_KV,
    request.userId,
    run.repo.owner,
    run.repo.name,
    findingId,
  );
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

  const active = run.findings.filter((f) => !f.suppressed);
  const suppressed = run.findings.filter((f) => f.suppressed);

  if (active.length === 0) {
    lines.push('No active defects at confidence ≥ 0.5 (precision threshold).');
  } else {
    lines.push(`Findings (${active.length}):`);
    lines.push('');
    active.forEach((f, idx) => appendFinding(lines, f, idx + 1));
  }

  if (suppressed.length > 0) {
    lines.push(
      `Suppressed findings (${suppressed.length}) — listed for transparency; excluded from the inline view by your prior /audit suppress decisions:`,
    );
    lines.push('');
    suppressed.forEach((f, idx) => appendFinding(lines, f, idx + 1, true));
  }

  appendSanitizationSummary(lines, run.sanitization);

  const t = run.telemetry;
  lines.push(
    `Cost: $${t.costUsd.toFixed(2)} • ${t.llmCalls} LLM calls • ${t.tokensIn.toLocaleString()} → ${t.tokensOut.toLocaleString()} tokens • ${t.githubApiCalls} API calls • ${(t.durationMs / 1000).toFixed(1)}s`,
  );
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

// ---------------------------------------------------------------------------
// Scheduled audits — /audit subscribe | unsubscribe | subs
// ---------------------------------------------------------------------------
//
// Storage: see src/skills/audit/cache.ts (audit:sub:* prefix in NEXUS_KV).
// Dispatch: see src/index.ts scheduled() — the 6h cron tick scans
// subscriptions and dispatches due ones via the existing TaskProcessor
// path. The handlers here only manage the subscription itself.

/**
 * Build a SkillRequest equivalent to a manual `/audit <repo> --analyze`
 * call, used by the cron handler when running a scheduled audit. Exposed
 * for the cron-side test, kept here so the inputs/outputs of the
 * subscription mechanism live in one place.
 */
export function buildScheduledAuditRequest(
  sub: AuditSubscription,
  env: SkillRequest['env'],
  context: SkillRequest['context'],
): SkillRequest {
  const flags: Record<string, string> = { analyze: 'true', depth: sub.depth };
  if (sub.lens) flags.lens = sub.lens;
  if (sub.branch) flags.branch = sub.branch;

  return {
    skillId: 'audit',
    subcommand: 'run',
    text: `${sub.owner}/${sub.repo}`,
    flags,
    transport: sub.transport,
    userId: sub.userId,
    chatId: sub.chatId,
    env,
    context,
  };
}

async function handleSubscribe(request: SkillRequest, start: number): Promise<SkillResult> {
  const repoArg = request.text.trim().split(/\s+/)[0] ?? '';
  if (!repoArg) {
    return errorResult(
      'Usage: /audit subscribe <owner/repo or URL> [--daily|--weekly] [--lens X] [--depth quick|standard|deep] [--branch <name>]',
    );
  }

  const coords = parseRepoCoords(repoArg);
  if (!coords) {
    return errorResult(
      `Could not parse "${repoArg}" as a GitHub repo. Use owner/repo or a github.com URL.`,
    );
  }

  // Cron only knows how to deliver to Telegram chats today. Reject from any
  // other transport so we don't silently store a sub that will never fire.
  if (request.transport !== 'telegram') {
    return errorResult('Audit subscriptions are Telegram-only for now. Use the bot to subscribe.');
  }
  if (request.chatId === undefined) {
    return errorResult(
      'Audit subscriptions require a chat context — invoke /audit subscribe from a Telegram chat.',
    );
  }

  // Cadence: --daily wins, otherwise default to weekly. We accept the
  // --weekly flag for symmetry but treat its absence as the default.
  const interval: AuditSubscription['interval'] =
    request.flags.daily === 'true' ? 'daily' : 'weekly';

  const lens = parseLensFlag(request.flags.lens);
  if (request.flags.lens && !lens) {
    return errorResult(`Unknown --lens "${request.flags.lens}". Valid: ${MVP_LENSES.join(', ')}.`);
  }
  const depth = parseDepthFlag(request.flags.depth) ?? 'quick';
  if (request.flags.depth && !parseDepthFlag(request.flags.depth)) {
    return errorResult(`Unknown --depth "${request.flags.depth}". Valid: quick, standard, deep.`);
  }

  // Preserve cadence state on overwrite so editing the cadence doesn't
  // accidentally re-trigger an audit that just ran. Also preserve any
  // in-flight dispatch marker — clearing it here would race with a cron
  // tick that's currently dispatching this sub.
  const existing = await getAuditSubscription(
    request.env.NEXUS_KV,
    request.userId,
    coords.owner,
    coords.repo,
  );

  const sub: AuditSubscription = {
    userId: request.userId,
    owner: coords.owner,
    repo: coords.repo,
    transport: 'telegram',
    chatId: request.chatId,
    branch: request.flags.branch,
    lens: lens ?? undefined,
    depth,
    interval,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    lastRunAt: existing?.lastRunAt ?? null,
    lastTaskId: existing?.lastTaskId ?? null,
    lastRunId: existing?.lastRunId ?? null,
    dispatchStartedAt: existing?.dispatchStartedAt,
  };

  const ok = await setAuditSubscription(request.env.NEXUS_KV, sub);
  if (!ok) {
    return errorResult(
      'Failed to persist subscription. KV may be unavailable; please retry shortly.',
    );
  }

  const verb = existing ? 'Updated' : 'Subscribed';
  const next = existing?.lastRunAt
    ? `; next run when more than ${interval === 'daily' ? '24h' : '7d'} elapses since ${existing.lastRunAt}`
    : '; first run on the next 6h cron tick';
  const lensSummary = lens ?? 'all lenses';
  return {
    skillId: 'audit',
    kind: 'text',
    body:
      `🔔 ${verb} ${coords.owner}/${coords.repo} for ${interval} audits ` +
      `(${lensSummary}, depth=${depth}${sub.branch ? `, branch=${sub.branch}` : ''})${next}.\n\n` +
      `View all subscriptions with /audit subs. Remove with /audit unsubscribe ${coords.owner}/${coords.repo}.`,
    data: { subscribed: true, interval, depth, lens: lens ?? null },
    telemetry: { durationMs: Date.now() - start, model: 'none', llmCalls: 0, toolCalls: 0 },
  };
}

async function handleUnsubscribe(request: SkillRequest, start: number): Promise<SkillResult> {
  const repoArg = request.text.trim().split(/\s+/)[0] ?? '';
  if (!repoArg) {
    return errorResult('Usage: /audit unsubscribe <owner/repo or URL>');
  }

  const coords = parseRepoCoords(repoArg);
  if (!coords) {
    return errorResult(
      `Could not parse "${repoArg}" as a GitHub repo. Use owner/repo or a github.com URL.`,
    );
  }

  const removed = await deleteAuditSubscription(
    request.env.NEXUS_KV,
    request.userId,
    coords.owner,
    coords.repo,
  );

  return {
    skillId: 'audit',
    kind: 'text',
    body: removed
      ? `🔕 Unsubscribed from ${coords.owner}/${coords.repo}. No more scheduled audits will run.`
      : `No active subscription found for ${coords.owner}/${coords.repo}.`,
    data: { removed },
    telemetry: { durationMs: Date.now() - start, model: 'none', llmCalls: 0, toolCalls: 0 },
  };
}

async function handleListSubs(request: SkillRequest, start: number): Promise<SkillResult> {
  const { entries: subs, truncated } = await listUserSubscriptions(
    request.env.NEXUS_KV,
    request.userId,
  );

  const body =
    subs.length === 0
      ? 'No active audit subscriptions.\n\nCreate one with /audit subscribe <owner/repo> [--daily|--weekly].'
      : formatSubsList(subs, truncated);

  return {
    skillId: 'audit',
    kind: 'text',
    body,
    data: { subscriptions: subs.length },
    telemetry: { durationMs: Date.now() - start, model: 'none', llmCalls: 0, toolCalls: 0 },
  };
}

// ---------------------------------------------------------------------------
// /audit grammars — bootstrap tree-sitter WASMs into R2 from a CDN
// ---------------------------------------------------------------------------
//
// This is the in-bot equivalent of `npm run audit:upload-grammars`: it
// fetches the same MVP grammar set + runtime from a public npm CDN
// (jsdelivr → unpkg fallback) and writes them to MOLTBOT_BUCKET in the
// exact manifest layout the loader expects. The point is to remove the
// "you need a laptop with `wrangler` configured" prerequisite for the
// audit pipeline so the bot can self-bootstrap and operate independently
// on arbitrary repos.

async function handleGrammars(request: SkillRequest, start: number): Promise<SkillResult> {
  const { bootstrapGrammars, renderBootstrapReport } = await import('./grammars/bootstrap');
  const dryRun = request.flags['dry-run'] === 'true' || request.flags.dry === 'true';
  const result = await bootstrapGrammars(
    { MOLTBOT_BUCKET: request.env.MOLTBOT_BUCKET },
    { dryRun },
  );
  return {
    skillId: 'audit',
    kind: result.ok ? 'text' : 'error',
    body: renderBootstrapReport(result),
    data: {
      manifestWritten: result.manifestWritten,
      bytesFetched: result.bytesFetched,
      items: result.items,
    },
    telemetry: {
      durationMs: Date.now() - start,
      model: 'none',
      llmCalls: 0,
      toolCalls: 0,
    },
  };
}

function formatSubsList(subs: AuditSubscription[], truncated = false): string {
  // Sort by created date so the user's mental model of "in the order I
  // added them" matches what's on screen. Subscriptions are tiny — at
  // most a few dozen per user — so we sort in-memory rather than
  // adding an indexed key.
  const ordered = [...subs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const headerSuffix = truncated ? '+' : '';
  const lines: string[] = [`Active audit subscriptions (${ordered.length}${headerSuffix}):`, ''];
  for (const s of ordered) {
    const lensSummary = s.lens ?? 'all lenses';
    const last = s.lastRunAt ? `last run ${s.lastRunAt}` : 'never run';
    const branch = s.branch ? `, branch=${s.branch}` : '';
    lines.push(
      `• ${s.owner}/${s.repo} — ${s.interval}, ${lensSummary}, depth=${s.depth}${branch} — ${last}`,
    );
  }
  if (truncated) {
    lines.push('');
    lines.push(
      '⚠️ List truncated — your account has more subscriptions than the per-scan cap. Contact the operator if you expect to see more.',
    );
  }
  lines.push('');
  lines.push('Remove one with /audit unsubscribe <owner/repo>.');
  return lines.join('\n');
}
