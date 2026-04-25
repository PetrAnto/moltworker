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
import { fetchSources } from './source-packs';
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

  const skillTaskRequest: SkillTaskRequest = {
    kind: 'skill',
    taskId,
    chatId,
    userId: request.userId,
    telegramToken,
    skillRequest: request,
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
  const sourceNames = classification && isQueryClassification(classification)
    ? classification.sources
    : ['webSearch', 'wikipedia']; // Fallback

  // 3. Fetch sources in parallel
  const { evidence, toolCalls } = await fetchSources(query, sourceNames, request.env, request.userId);

  if (evidence.length === 0) {
    return makeError(request, 'Could not retrieve any sources for this query. Try rephrasing.');
  }

  // 4. Synthesize
  const synthesizePrompt = mode === 'decision' ? NEXUS_DECISION_PROMPT : NEXUS_SYNTHESIZE_PROMPT;
  const evidenceText = formatEvidenceForLLM(evidence);

  const synthesisResult = await callSkillLLM({
    systemPrompt: `${systemPrompt}\n\n${synthesizePrompt}`,
    userPrompt: `Research query: ${query}\n\nEvidence:\n${evidenceText}`,
    modelAlias: model,
    responseFormat: { type: 'json_object' },
    env: request.env,
  });
  llmCalls++;

  const synthesis = safeJsonParse<SynthesisResponse>(synthesisResult.text);
  const synthesisText = synthesis && isSynthesisResponse(synthesis)
    ? synthesis.synthesis
    : synthesisResult.text;

  // 5. Build dossier
  const dossier: NexusDossier = {
    query,
    mode,
    synthesis: synthesisText,
    evidence,
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
