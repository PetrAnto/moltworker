/**
 * Gecko Skills — Skill Tool Executor
 *
 * Wraps the base executeTool with per-skill policy enforcement.
 * Skills that need tool access (e.g. Lyra's /repurpose fetching a URL)
 * must go through this helper, which checks the tool-policy allowlist.
 */

import { executeTool, AVAILABLE_TOOLS, type ToolCall, type ToolResult, type ToolContext, type ToolDefinition } from '../openrouter/tools';
import { getToolAllowlist } from './tool-policy';
import { buildWebSearchLimiter } from '../rate-limit/web-search-limiter';
import type { SkillId } from './types';
import type { MoltbotEnv } from '../types';

/**
 * Execute a tool call on behalf of a skill, enforcing the skill's tool policy.
 *
 * Returns a ToolResult — either the real result or an error if the tool is denied.
 */
export async function executeSkillTool(
  skillId: SkillId,
  toolCall: ToolCall,
  context?: ToolContext,
): Promise<ToolResult> {
  const allowlist = getToolAllowlist(skillId);

  if (!allowlist.has(toolCall.function.name)) {
    return {
      tool_call_id: toolCall.id,
      role: 'tool',
      content: `Error: Tool "${toolCall.function.name}" is not allowed for skill "${skillId}".`,
    };
  }

  return executeTool(toolCall, context);
}

/**
 * Get the filtered list of tool definitions allowed for a skill.
 * Use this when building the tool list for an LLM call within a skill handler.
 */
export function getSkillTools(skillId: SkillId): ToolDefinition[] {
  const allowlist = getToolAllowlist(skillId);
  if (allowlist.size === 0) return [];
  return AVAILABLE_TOOLS.filter(t => allowlist.has(t.function.name));
}

/**
 * Build a ToolContext from worker env bindings for use in skill tool calls.
 */
export function buildSkillToolContext(env: MoltbotEnv, userId?: string): ToolContext {
  // Build a rate limiter so skill-invoked web_search is capped identically
  // to DO-invoked web_search. Requires both R2 and a userId; when either is
  // missing the limiter is undefined (no enforcement), matching the DO's
  // fallback behavior on misconfigured infrastructure.
  const webSearchLimiter = userId && env.MOLTBOT_BUCKET
    ? buildWebSearchLimiter({
        r2: env.MOLTBOT_BUCKET,
        userId,
        env: {
          WEB_SEARCH_USER_DAILY_LIMIT: env.WEB_SEARCH_USER_DAILY_LIMIT,
          WEB_SEARCH_TASK_LIMIT: env.WEB_SEARCH_TASK_LIMIT,
          WEB_SEARCH_GLOBAL_DAILY_LIMIT: env.WEB_SEARCH_GLOBAL_DAILY_LIMIT,
          WEB_SEARCH_ALLOWLIST_USERS: env.WEB_SEARCH_ALLOWLIST_USERS,
        },
      })
    : undefined;

  return {
    githubToken: env.GITHUB_TOKEN,
    braveSearchKey: env.BRAVE_SEARCH_KEY,
    tavilyKey: env.TAVILY_API_KEY,
    webSearchLimiter,
    browser: env.BROWSER,
    r2Bucket: env.MOLTBOT_BUCKET,
    r2FilePrefix: userId ? `files/${userId}/` : undefined,
    cloudflareApiToken: env.CLOUDFLARE_API_TOKEN,
  };
}
