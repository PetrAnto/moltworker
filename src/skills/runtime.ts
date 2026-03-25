/**
 * Gecko Skills — Runtime
 *
 * Executes a skill request through the registry:
 *   1. Resolve handler from registry
 *   2. Optionally load hot-prompt from R2
 *   3. Execute with duration tracking
 *   4. Wrap errors
 */

import type { SkillRequest, SkillResult } from './types';
import { getSkillHandler } from './registry';

// ---------------------------------------------------------------------------
// Hot-prompt loading (R2)
// ---------------------------------------------------------------------------

/**
 * Attempt to load a skill's system prompt from R2.
 * Path convention: prompts/{skillId}/system.md
 *
 * Returns null if not found (skill uses its bundled fallback).
 */
async function loadHotPrompt(
  bucket: R2Bucket,
  skillId: string,
): Promise<string | null> {
  const key = `prompts/${skillId}/system.md`;
  try {
    const obj = await bucket.get(key);
    if (!obj) return null;
    return await obj.text();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Runtime executor
// ---------------------------------------------------------------------------

/**
 * Run a skill through the registry.
 *
 * @param request - The skill request
 * @returns The skill result, or an error result if the handler fails
 */
export async function runSkill(request: SkillRequest): Promise<SkillResult> {
  const handler = getSkillHandler(request.skillId);
  if (!handler) {
    return {
      skillId: request.skillId,
      kind: 'error',
      body: `Unknown skill: ${request.skillId}`,
      telemetry: { durationMs: 0, model: 'none', llmCalls: 0, toolCalls: 0 },
    };
  }

  const start = Date.now();

  try {
    // Load hot-prompt from R2 (if bucket available).
    // Skills can check request for an injected hot-prompt via data.
    if (request.env.MOLTBOT_BUCKET) {
      const hotPrompt = await loadHotPrompt(request.env.MOLTBOT_BUCKET, request.skillId);
      if (hotPrompt) {
        // Attach hot-prompt as data so the handler can use it
        (request as SkillRequest & { hotPrompt?: string }).hotPrompt = hotPrompt;
      }
    }

    const result = await handler(request);

    // Ensure duration is tracked even if the handler didn't set it
    if (result.telemetry.durationMs === 0) {
      result.telemetry.durationMs = Date.now() - start;
    }

    return result;
  } catch (err) {
    const durationMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[runSkill] ${request.skillId}/${request.subcommand} failed after ${durationMs}ms:`, message);

    return {
      skillId: request.skillId,
      kind: 'error',
      body: `Skill error (${request.skillId}): ${message}`,
      telemetry: { durationMs, model: request.modelAlias ?? 'unknown', llmCalls: 0, toolCalls: 0 },
    };
  }
}

export { loadHotPrompt };
