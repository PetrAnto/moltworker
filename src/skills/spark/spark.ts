/**
 * Spark (Tach) — Brainstorm + Ideas Skill Handler
 *
 * Commands: /save, /bookmark, /spark, /gauntlet, /brainstorm, /ideas
 */

import type { SkillRequest, SkillResult, SkillMeta } from '../types';
import { selectSkillModel } from '../llm';
import { captureItem, listInbox, formatInbox } from './capture';
import { quickReaction, formatReaction, runGauntlet, formatGauntlet } from './gauntlet';
import { brainstormItems, formatBrainstorm } from './brainstorm';

export const SPARK_META: SkillMeta = {
  id: 'spark',
  name: 'Spark',
  description: 'Brainstorm and ideas — capture, evaluate, and develop ideas',
  defaultModel: 'flash',
  subcommands: ['save', 'spark', 'gauntlet', 'brainstorm', 'list'],
};

export async function handleSpark(request: SkillRequest): Promise<SkillResult> {
  switch (request.subcommand) {
    case 'save':
      return executeSave(request);
    case 'spark':
      return executeSpark(request);
    case 'gauntlet':
      return executeGauntlet(request);
    case 'brainstorm':
      return executeBrainstorm(request);
    case 'list':
      return executeListInbox(request);
    default:
      return makeError(request, `Unknown Spark subcommand: ${request.subcommand}`);
  }
}

// ---------------------------------------------------------------------------
// /save — capture an idea
// ---------------------------------------------------------------------------

async function executeSave(request: SkillRequest): Promise<SkillResult> {
  if (!request.text.trim()) {
    return makeError(request, 'Please provide an idea to save. Usage: /save <idea or URL>');
  }

  const start = Date.now();
  const { item, toolCalls } = await captureItem(request.text.trim(), request.userId, request.env);

  const ack = item.url
    ? `Saved: "${item.text.slice(0, 60)}${item.text.length > 60 ? '...' : ''}"${item.summary ? `\n${item.summary}` : ''}`
    : `Saved: "${item.text.slice(0, 100)}${item.text.length > 100 ? '...' : ''}"`;

  return {
    skillId: 'spark',
    kind: 'capture_ack',
    body: ack,
    data: item,
    telemetry: {
      durationMs: Date.now() - start,
      model: 'none',
      llmCalls: 0,
      toolCalls,
    },
  };
}

// ---------------------------------------------------------------------------
// /spark — quick reaction
// ---------------------------------------------------------------------------

async function executeSpark(request: SkillRequest): Promise<SkillResult> {
  if (!request.text.trim()) {
    return makeError(request, 'Please provide an idea. Usage: /spark <idea>');
  }

  const start = Date.now();
  const model = selectSkillModel(request.modelAlias, SPARK_META.defaultModel);
  const { reaction, llmResult } = await quickReaction(
    request.text.trim(),
    model,
    request.env,
    request.context?.hotPrompt,
  );

  return {
    skillId: 'spark',
    kind: 'text',
    body: formatReaction(reaction),
    data: reaction,
    telemetry: {
      durationMs: Date.now() - start,
      model,
      llmCalls: 1,
      toolCalls: 0,
      tokens: llmResult.tokens,
    },
  };
}

// ---------------------------------------------------------------------------
// /gauntlet — 6-stage evaluation
// ---------------------------------------------------------------------------

async function executeGauntlet(request: SkillRequest): Promise<SkillResult> {
  if (!request.text.trim()) {
    return makeError(request, 'Please provide an idea to evaluate. Usage: /gauntlet <idea>');
  }

  const start = Date.now();
  const model = selectSkillModel(request.modelAlias, SPARK_META.defaultModel);
  const { gauntlet, llmResult } = await runGauntlet(
    request.text.trim(),
    model,
    request.env,
    request.context?.hotPrompt,
  );

  return {
    skillId: 'spark',
    kind: 'gauntlet',
    body: formatGauntlet(gauntlet),
    data: gauntlet,
    telemetry: {
      durationMs: Date.now() - start,
      model,
      llmCalls: 1,
      toolCalls: 0,
      tokens: llmResult.tokens,
    },
  };
}

// ---------------------------------------------------------------------------
// /brainstorm — cluster all inbox items
// ---------------------------------------------------------------------------

async function executeBrainstorm(request: SkillRequest): Promise<SkillResult> {
  const start = Date.now();
  const model = selectSkillModel(request.modelAlias, SPARK_META.defaultModel);

  const items = await listInbox(request.userId, request.env);
  if (items.length === 0) {
    return makeError(request, 'Your ideas inbox is empty. Use /save to capture ideas first.');
  }

  if (items.length < 2) {
    return makeError(request, 'Need at least 2 ideas to brainstorm. Save more ideas with /save.');
  }

  const { result, llmResult } = await brainstormItems(
    items,
    model,
    request.env,
    request.context?.hotPrompt,
  );

  return {
    skillId: 'spark',
    kind: 'digest',
    body: formatBrainstorm(result),
    data: result,
    telemetry: {
      durationMs: Date.now() - start,
      model,
      llmCalls: 1,
      toolCalls: 0,
      tokens: llmResult.tokens,
    },
  };
}

// ---------------------------------------------------------------------------
// /ideas — list inbox
// ---------------------------------------------------------------------------

async function executeListInbox(request: SkillRequest): Promise<SkillResult> {
  const start = Date.now();
  const items = await listInbox(request.userId, request.env);

  return {
    skillId: 'spark',
    kind: 'digest',
    body: formatInbox(items),
    data: { count: items.length },
    telemetry: {
      durationMs: Date.now() - start,
      model: 'none',
      llmCalls: 0,
      toolCalls: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeError(request: SkillRequest, message: string): SkillResult {
  return {
    skillId: 'spark',
    kind: 'error',
    body: message,
    telemetry: {
      durationMs: 0,
      model: request.modelAlias ?? SPARK_META.defaultModel,
      llmCalls: 0,
      toolCalls: 0,
    },
  };
}
