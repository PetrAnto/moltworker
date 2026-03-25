/**
 * Spark — Brainstorm Service
 *
 * Clusters inbox items and generates insights + challenges.
 */

import type { SparkItem, BrainstormResult } from './types';
import { isBrainstormResult } from './types';
import { callSkillLLM } from '../llm';
import { SPARK_SYSTEM_PROMPT, SPARK_BRAINSTORM_PROMPT } from './prompts';
import { safeJsonParse } from '../validators';
import type { MoltbotEnv } from '../../types';
import type { CallSkillLLMResult } from '../llm';

/**
 * Cluster and challenge inbox items.
 */
export async function brainstormItems(
  items: SparkItem[],
  model: string,
  env: MoltbotEnv,
  hotPrompt?: string,
): Promise<{ result: BrainstormResult; llmResult: CallSkillLLMResult }> {
  const systemPrompt = hotPrompt ?? SPARK_SYSTEM_PROMPT;

  // Build a text representation of all items
  const itemsText = items
    .map(item => `- [${item.id}] ${item.text}${item.summary ? ` (${item.summary})` : ''}`)
    .join('\n');

  const llmResult = await callSkillLLM({
    systemPrompt: `${systemPrompt}\n\n${SPARK_BRAINSTORM_PROMPT}`,
    userPrompt: `Ideas to analyze:\n${itemsText}`,
    modelAlias: model,
    responseFormat: { type: 'json_object' },
    env,
  });

  const parsed = safeJsonParse<BrainstormResult>(llmResult.text);
  if (parsed && isBrainstormResult(parsed)) {
    return { result: parsed, llmResult };
  }

  // Fallback
  return {
    result: { clusters: [], synthesis: llmResult.text },
    llmResult,
  };
}

/**
 * Format brainstorm result for display.
 */
export function formatBrainstorm(result: BrainstormResult): string {
  const lines: string[] = [];

  if (result.clusters.length === 0) {
    lines.push(result.synthesis || 'No clear clusters found.');
    return lines.join('\n');
  }

  for (const cluster of result.clusters) {
    lines.push(`\u25cf ${cluster.theme}`);
    lines.push(`  ${cluster.insight}`);
    lines.push(`  Challenge: ${cluster.challenge}`);
    lines.push('');
  }

  lines.push(`Synthesis: ${result.synthesis}`);
  return lines.join('\n');
}
