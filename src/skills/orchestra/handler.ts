/**
 * Gecko Skills — Orchestra Handler Adapter
 *
 * Wraps the existing orchestra logic as a SkillHandler.
 * This is a thin adapter — the actual orchestra logic remains in orchestra.ts
 * and is invoked from the Telegram handler / Durable Object as before.
 *
 * For Phase 0, this handler provides a status/info response for
 * orchestra commands routed through the skill runtime. Full orchestra
 * execution (init/run/do/redo) still goes through the existing handler.ts
 * path because it requires Telegram bot context, Durable Objects, etc.
 */

import type { SkillRequest, SkillResult, SkillMeta } from '../types';

/** Metadata for the orchestra skill. */
export const ORCHESTRA_META: SkillMeta = {
  id: 'orchestra',
  name: 'Orchestra',
  description: 'AI coding agent — roadmap planning and task execution',
  defaultModel: 'sonnet',
  subcommands: ['init', 'run', 'redo', 'do', 'draft', 'next', 'status', 'history', 'plan', 'lock', 'unlock', 'health', 'reset'],
};

/**
 * Orchestra skill handler.
 *
 * NOTE: In Phase 0, orchestra commands that require Telegram bot context
 * (init, run, do, redo, draft) are NOT routed through the skill runtime.
 * They continue through the legacy handler.ts code path.
 *
 * This handler covers read-only / info subcommands that can be served
 * without the full Telegram bot context.
 */
export async function handleOrchestra(request: SkillRequest): Promise<SkillResult> {
  const start = Date.now();

  const result: SkillResult = {
    skillId: 'orchestra',
    kind: 'orchestra',
    body: `Orchestra command received: /${request.subcommand} ${request.text}`.trim(),
    telemetry: {
      durationMs: Date.now() - start,
      model: request.modelAlias ?? ORCHESTRA_META.defaultModel,
      llmCalls: 0,
      toolCalls: 0,
    },
  };

  return result;
}
