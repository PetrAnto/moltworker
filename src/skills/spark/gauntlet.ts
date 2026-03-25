/**
 * Spark — Gauntlet + Quick Reaction Services
 */

import type { SparkReaction, SparkGauntlet } from './types';
import { isSparkReaction, isSparkGauntlet } from './types';
import { callSkillLLM } from '../llm';
import {
  SPARK_SYSTEM_PROMPT,
  SPARK_REACTION_PROMPT,
  SPARK_GAUNTLET_PROMPT,
} from './prompts';
import { safeJsonParse } from '../validators';
import type { MoltbotEnv } from '../../types';
import type { CallSkillLLMResult } from '../llm';

/**
 * Quick reaction to an idea (/spark).
 */
export async function quickReaction(
  idea: string,
  model: string,
  env: MoltbotEnv,
  hotPrompt?: string,
): Promise<{ reaction: SparkReaction; llmResult: CallSkillLLMResult }> {
  const systemPrompt = hotPrompt ?? SPARK_SYSTEM_PROMPT;

  const result = await callSkillLLM({
    systemPrompt: `${systemPrompt}\n\n${SPARK_REACTION_PROMPT}`,
    userPrompt: `Idea: ${idea}`,
    modelAlias: model,
    responseFormat: { type: 'json_object' },
    env,
  });

  const parsed = safeJsonParse<SparkReaction>(result.text);
  if (parsed && isSparkReaction(parsed)) {
    return { reaction: parsed, llmResult: result };
  }

  // Fallback
  return {
    reaction: { reaction: result.text, angle: '', nextStep: '' },
    llmResult: result,
  };
}

/**
 * Format a quick reaction for display.
 */
export function formatReaction(reaction: SparkReaction): string {
  const lines: string[] = [];
  lines.push(reaction.reaction);
  if (reaction.angle) lines.push(`\nAngle: ${reaction.angle}`);
  if (reaction.nextStep) lines.push(`Next step: ${reaction.nextStep}`);
  return lines.join('\n');
}

/**
 * Full 6-stage gauntlet evaluation (/gauntlet).
 */
export async function runGauntlet(
  idea: string,
  model: string,
  env: MoltbotEnv,
  hotPrompt?: string,
): Promise<{ gauntlet: SparkGauntlet; llmResult: CallSkillLLMResult }> {
  const systemPrompt = hotPrompt ?? SPARK_SYSTEM_PROMPT;

  const result = await callSkillLLM({
    systemPrompt: `${systemPrompt}\n\n${SPARK_GAUNTLET_PROMPT}`,
    userPrompt: `Idea to evaluate: ${idea}`,
    modelAlias: model,
    responseFormat: { type: 'json_object' },
    env,
  });

  const parsed = safeJsonParse<SparkGauntlet>(result.text);
  if (parsed && isSparkGauntlet(parsed)) {
    return { gauntlet: parsed, llmResult: result };
  }

  // Fallback: wrap as a minimal gauntlet
  return {
    gauntlet: {
      idea,
      stages: [],
      verdict: result.text,
      overallScore: 0,
    },
    llmResult: result,
  };
}

/**
 * Format a gauntlet result for display.
 */
export function formatGauntlet(g: SparkGauntlet): string {
  const lines: string[] = [];
  lines.push(`Gauntlet: ${g.idea}\n`);

  for (const stage of g.stages) {
    const bar = '█'.repeat(stage.score) + '░'.repeat(5 - stage.score);
    lines.push(`${bar} ${stage.name} (${stage.score}/5)`);
    lines.push(`  ${stage.assessment}`);
  }

  lines.push(`\nOverall: ${g.overallScore.toFixed(1)}/5`);
  lines.push(`Verdict: ${g.verdict}`);

  return lines.join('\n');
}
