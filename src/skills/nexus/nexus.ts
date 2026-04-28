/**
 * Nexus (Omni) — Research Skill Handler
 *
 * Modes:
 *   /research <topic>           → quick mode (default)
 *   /research <topic> --quick   → explicit quick mode
 *   /research <topic> --decision → decision mode (pros/cons/risks)
 *   /dossier <entity>           → full mode (currently same as quick, HITL gate deferred to DO extension)
 */

import type { SkillRequest, SkillResult, SkillMeta } from '../types';
import type { SkillTaskRequest } from '../../durable-objects/task-processor';
import type { TaskProcessor } from '../../durable-objects/task-processor';
import type { NexusDossier, SynthesisResponse, QueryClassification } from './types';
import { isSynthesisResponse, isQueryClassification } from './types';
import { callSkillLLM, selectSkillModel } from '../llm';
import { fetchSources, expandSourcePicks } from './source-packs';
import { getCachedDossier, cacheDossier } from './cache';
import { computeConfidence, confidenceLabel, formatEvidenceForLLM, formatEvidenceSummary } from './evidence';
import { safeJsonParse } from '../validators';
import {
  NEXUS_SYSTEM_PROMPT,
  NEXUS_CLASSIFY_PROMPT,
  NEXUS_SYNTHESIZE_PROMPT,
  NEXUS_DECISION_PROMPT,
} from './prompts';

export const NEXUS_META: SkillMeta = {
  id: 'nexus',
  name: 'Nexus',
  description: 'Research — multi-source evidence gathering, synthesis, and decision analysis',
  defaultModel: 'flash',
  subcommands: ['research', 'dossier'],
};

export async function handleNexus(request: SkillRequest): Promise<SkillResult> {
  // Determine mode from flags
  const isDecision = request.flags.decision === 'true' || request.subcommand === 'decision';
  const mode = isDecision ? 'decision' : 'quick';

  if (request.subcommand === 'dossier') {
    // Full dossier — dispatch to DO for async execution when possible
    return dispatchOrInline(request);
  }

  return executeResearch(request, mode);
}

/**
 * Dispatch full dossier to TaskProcessor DO for async execution.
 * Falls back to inline if transport is not Telegram or TASK_PROCESSOR is unavailable.
 */
async function dispatchOrInline(request: SkillRequest): Promise<SkillResult> {
  const taskProcessor = request.env.TASK_PROCESSOR as DurableObjectNamespace<TaskProcessor> | undefined;

  // Fallback: run inline when DO is unavailable or transport is not Telegram.
  // We also verify `idFromName` is a real function — bindings don't survive JSON
  // serialization, so a TASK_PROCESSOR that crossed a `fetch()` boundary arrives
  // as a plain object (truthy but missing methods). Treat that as "unavailable".
  const hasUsableBinding = typeof taskProcessor?.idFromName === 'function'
    && typeof taskProcessor?.get === 'function';
  if (!hasUsableBinding || request.transport !== 'telegram') {
    return executeResearch(request, 'full');
  }

  if (!request.text.trim()) {
    return makeError(request, 'Please provide a topic. Usage: /dossier <topic>');
  }

  // Validate required wiring for async dispatch — fall back inline if missing
  const telegramToken = request.context?.telegramToken;
  const chatId = request.chatId;
  if (!telegramToken || !chatId) {
    console.error('[Nexus] Missing telegramToken or chatId for DO dispatch, falling back inline');
    return executeResearch(request, 'full');
  }

  const taskId = crypto.randomUUID();
  const doId = taskProcessor.idFromName(`nexus-${request.userId}-${taskId}`);
  const stub = taskProcessor.get(doId);

  // Strip `env` from the wire payload — Workers bindings (R2/KV/DO/Fetcher)
  // do NOT survive JSON serialization. The DO authoritatively rebuilds env
  // from its own bindings + the explicit secrets below. Sending a sentinel
  // makes any accidental DO-side use of `request.skillRequest.env` crash
  // loudly with "cannot read X of undefined" instead of silently calling
  // methods on `{}` (the source of "idFromName is not a function").
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

  try {
    await stub.fetch('https://do/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(skillTaskRequest),
    });
  } catch (err) {
    // DO dispatch failed — fall back to inline
    console.error('[Nexus] DO dispatch failed, falling back to inline:', err instanceof Error ? err.message : err);
    return executeResearch(request, 'full');
  }

  // Return immediately with "in progress" message
  return {
    skillId: 'nexus',
    kind: 'text',
    body: `🔬 Deep research started for "${request.text.trim()}"\n\nResults will arrive in this chat when complete.`,
    data: { taskId, async: true },
    telemetry: {
      durationMs: 0,
      model: request.modelAlias ?? NEXUS_META.defaultModel,
      llmCalls: 0,
      toolCalls: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Core research flow
// ---------------------------------------------------------------------------

async function executeResearch(
  request: SkillRequest,
  mode: 'quick' | 'full' | 'decision',
): Promise<SkillResult> {
  if (!request.text.trim()) {
    return makeError(request, `Please provide a topic. Usage: /${request.subcommand} <topic>`);
  }

  const start = Date.now();
  const model = selectSkillModel(request.modelAlias, NEXUS_META.defaultModel);
  const systemPrompt = request.context?.hotPrompt ?? NEXUS_SYSTEM_PROMPT;
  const query = request.text.trim();
  let llmCalls = 0;

  // 1. Check cache (skip for decision mode — always fresh)
  if (mode !== 'decision') {
    const cached = await getCachedDossier(request.env.NEXUS_KV, query, mode);
    if (cached) {
      return {
        skillId: 'nexus',
        kind: 'dossier',
        body: formatDossier(cached),
        data: cached,
        telemetry: {
          durationMs: Date.now() - start,
          model,
          llmCalls: 0,
          toolCalls: 0,
        },
      };
    }
  }

  // 2. Classify query → select sources
  const classifyResult = await callSkillLLM({
    systemPrompt: `${systemPrompt}\n\n${NEXUS_CLASSIFY_PROMPT}`,
    userPrompt: `Query: ${query}`,
    modelAlias: model,
    responseFormat: { type: 'json_object' },
    env: request.env,
  });
  llmCalls++;

  const classification = safeJsonParse<QueryClassification>(classifyResult.text);
  const classifierPicks = classification && isQueryClassification(classification)
    ? classification.sources
    : ['webSearch', 'wikipedia']; // Fallback when classifier output isn't usable
  const category = classification && isQueryClassification(classification)
    ? classification.category
    : undefined;
  const llmKeywordQuery = classification && isQueryClassification(classification)
    ? classification.keywordQuery
    : undefined;

  // Always expand the classifier's picks with category-default backbones so
  // a thin pick (e.g. just ["webSearch"]) still fans out to complementary
  // sources. Mitigates the single-source dossiers we saw in production
  // when the classifier was conservative.
  const sourceNames = expandSourcePicks(category, classifierPicks);

  // Log so production debugging doesn't require simulate replay — when a
  // dossier comes back with fewer sources than expected, the worker log
  // shows what the classifier asked for and what we expanded it to.
  console.log(
    `[Nexus] category=${category ?? 'unknown'} classifierPicks=${JSON.stringify(classifierPicks)} ` +
    `expanded=${JSON.stringify(sourceNames)} keywordQuery=${JSON.stringify(llmKeywordQuery)}`,
  );

  // 3. Fetch sources in parallel. Pass the LLM-distilled keyword query so
  // keyword-strict APIs (GitHub, Stack Exchange, Wikidata, World Bank, SEC
  // EDGAR) don't trip on natural-language phrasing.
  const { evidence, toolCalls, attempts } = await fetchSources(
    query,
    sourceNames,
    request.env,
    request.userId,
    { keywordQuery: llmKeywordQuery },
  );
  console.log(`[Nexus] sources returned evidence: ${JSON.stringify(evidence.map(e => e.source))} (${evidence.length}/${sourceNames.length})`);

  if (evidence.length === 0) {
    return makeError(request, 'Could not retrieve any sources for this query. Try rephrasing.');
  }

  // 4. Synthesize. Pass the explicit source list so the LLM has nothing to
  // extrapolate — single-source dossiers were producing a [Source 2]
  // hallucination under the old [Source N] indexing, and the prior fix's
  // strict "Do NOT" prompt got kimi26or to return an empty synthesis.
  const synthesizePrompt = mode === 'decision' ? NEXUS_DECISION_PROMPT : NEXUS_SYNTHESIZE_PROMPT;
  const evidenceText = formatEvidenceForLLM(evidence);
  const availableSources = evidence.map(e => `[${e.source}]`).join(', ');

  const synthesisResult = await callSkillLLM({
    systemPrompt: `${systemPrompt}\n\n${synthesizePrompt}`,
    userPrompt: `Research query: ${query}\n\nAvailable sources (use these names verbatim in citations): ${availableSources}\n\nEvidence:\n${evidenceText}`,
    modelAlias: model,
    responseFormat: { type: 'json_object' },
    env: request.env,
  });
  llmCalls++;

  const synthesis = safeJsonParse<SynthesisResponse>(synthesisResult.text);
  let synthesisText = synthesis && isSynthesisResponse(synthesis)
    ? synthesis.synthesis
    : synthesisResult.text;

  // Guard: an empty/whitespace synthesis renders as a blank dossier (just
  // the heading and source list), which is invisible to the user. Log the
  // raw LLM output once so the next occurrence is debuggable, then
  // substitute a visible fallback message.
  if (!synthesisText || !synthesisText.trim()) {
    console.warn(
      `[Nexus] empty synthesis returned by ${model}; raw response: ${JSON.stringify(synthesisResult.text).slice(0, 500)}`,
    );
    synthesisText = `(The model returned no synthesis for this query. ${evidence.length} source${evidence.length === 1 ? '' : 's'} were retrieved — try rephrasing the query or running again.)`;
  }

  // 5. Build dossier
  const dossier: NexusDossier = {
    query,
    mode,
    synthesis: synthesisText,
    evidence,
    attempts,
    decision: synthesis && isSynthesisResponse(synthesis) ? synthesis.decision : undefined,
    createdAt: new Date().toISOString(),
  };

  // 6. Cache (async, non-blocking)
  cacheDossier(request.env.NEXUS_KV, dossier).catch(() => {});

  return {
    skillId: 'nexus',
    kind: 'dossier',
    body: formatDossier(dossier),
    data: dossier,
    telemetry: {
      durationMs: Date.now() - start,
      model,
      llmCalls,
      toolCalls,
      tokens: synthesisResult.tokens,
    },
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatDossier(dossier: NexusDossier): string {
  const lines: string[] = [];

  const confidence = computeConfidence(dossier.evidence);
  lines.push(`Research: ${dossier.query}`);
  lines.push(`${confidenceLabel(confidence)} (${dossier.evidence.length} sources, ${dossier.mode} mode)\n`);

  lines.push(dossier.synthesis);

  if (dossier.decision) {
    lines.push('\n--- Decision Analysis ---');
    if (dossier.decision.pros.length > 0) {
      lines.push('\nPros:');
      dossier.decision.pros.forEach(p => lines.push(`  + ${p}`));
    }
    if (dossier.decision.cons.length > 0) {
      lines.push('\nCons:');
      dossier.decision.cons.forEach(c => lines.push(`  - ${c}`));
    }
    if (dossier.decision.risks.length > 0) {
      lines.push('\nRisks:');
      dossier.decision.risks.forEach(r => lines.push(`  ! ${r}`));
    }
    lines.push(`\nRecommendation: ${dossier.decision.recommendation}`);
  }

  lines.push('\nSources:');
  lines.push(formatEvidenceSummary(dossier.evidence));

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeError(request: SkillRequest, message: string): SkillResult {
  return {
    skillId: 'nexus',
    kind: 'error',
    body: message,
    telemetry: {
      durationMs: 0,
      model: request.modelAlias ?? NEXUS_META.defaultModel,
      llmCalls: 0,
      toolCalls: 0,
    },
  };
}
