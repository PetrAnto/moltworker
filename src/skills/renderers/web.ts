/**
 * Gecko Skills — Web/API Renderer
 *
 * Converts SkillResult into a JSON envelope for the ai-hub API
 * and the /api/skills/execute endpoint.
 */

import type { SkillResult } from '../types';

/** JSON envelope returned by the skills API. */
export interface SkillApiResponse {
  ok: boolean;
  skillId: string;
  kind: string;
  body: string;
  data?: unknown;
  telemetry: {
    durationMs: number;
    model: string;
    llmCalls: number;
    toolCalls: number;
    tokens?: { prompt: number; completion: number };
  };
}

/**
 * Render a SkillResult as a JSON API response envelope.
 */
export function renderForWeb(result: SkillResult): SkillApiResponse {
  return {
    ok: result.kind !== 'error',
    skillId: result.skillId,
    kind: result.kind,
    body: result.body,
    data: result.data,
    telemetry: result.telemetry,
  };
}
