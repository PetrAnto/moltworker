/**
 * Gecko Skills — Tool Policy
 *
 * Per-skill allowlists controlling which tools a skill may use
 * when running through the tool-calling loop.
 *
 * If a skill is not listed here, it gets NO tools (LLM-only).
 */

import type { SkillId } from './types';

/** Set of tool names a skill is allowed to use. */
export type ToolAllowlist = ReadonlySet<string>;

const TOOL_POLICIES: Record<SkillId, readonly string[]> = {
  // Orchestra: full GitHub + code access for repo operations
  orchestra: [
    'fetch_url',
    'web_search',
    'github_read_file',
    'github_list_files',
    'github_api',
    'github_create_pr',
    'github_push_files',
    'github_merge_pr',
    'workspace_write_file',
    'workspace_delete_file',
    'workspace_commit',
    'sandbox_exec',
    'run_code',
  ],

  // Lyra: content creation — needs URL fetch for repurpose, web search for research
  lyra: [
    'fetch_url',
    'web_search',
    'browse_url',
    'url_metadata',
  ],

  // Spark: brainstorm — needs URL fetch for bookmark summaries, web search
  spark: [
    'fetch_url',
    'web_search',
    'browse_url',
    'url_metadata',
  ],

  // Nexus: research — broad read access, no write access
  nexus: [
    'fetch_url',
    'web_search',
    'browse_url',
    'url_metadata',
    'github_read_file',
    'github_list_files',
    'github_api',
    'fetch_news',
    'get_crypto',
    'convert_currency',
    'get_weather',
  ],

  // Audit: read-only repo access. v0 (Scout-only) uses no LLM tools — all
  // GitHub fetching is direct. The allowlist becomes meaningful once the
  // Analyst lands and may use github_read_file for follow-up evidence.
  audit: [
    'github_read_file',
    'github_list_files',
    'github_api',
  ],
};

// Pre-build Sets for fast lookup
const policyCache = new Map<SkillId, ToolAllowlist>();

/**
 * Get the tool allowlist for a skill.
 * Returns an empty set if the skill has no policy (no tools allowed).
 */
export function getToolAllowlist(skillId: SkillId): ToolAllowlist {
  let cached = policyCache.get(skillId);
  if (!cached) {
    const names = TOOL_POLICIES[skillId] ?? [];
    cached = new Set(names);
    policyCache.set(skillId, cached);
  }
  return cached;
}

/**
 * Check if a specific tool is allowed for a skill.
 */
export function isToolAllowed(skillId: SkillId, toolName: string): boolean {
  return getToolAllowlist(skillId).has(toolName);
}
