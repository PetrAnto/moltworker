/**
 * Gecko Skills — Command Map
 *
 * Maps Telegram/API commands to skill IDs + subcommands.
 * Also provides a regex-based flag parser for extracting --key value pairs.
 */

import type { SkillId } from './types';

// ---------------------------------------------------------------------------
// Command → Skill mapping
// ---------------------------------------------------------------------------

export interface CommandMapping {
  skillId: SkillId;
  /** Default subcommand when none is parsed from the user input. */
  defaultSubcommand: string;
}

/**
 * Static map of bot commands → skill routing.
 * Only commands listed here go through the skill runtime.
 * All other commands continue through the legacy handler.
 */
export const COMMAND_SKILL_MAP: Record<string, CommandMapping> = {
  // Orchestra (Phase 0 — only skill wired initially)
  '/orch':      { skillId: 'orchestra', defaultSubcommand: 'run' },
  '/orchestra': { skillId: 'orchestra', defaultSubcommand: 'run' },

  // Lyra — Content Creator (Phase 1)
  '/write':      { skillId: 'lyra', defaultSubcommand: 'write' },
  '/rewrite':    { skillId: 'lyra', defaultSubcommand: 'rewrite' },
  '/headline':   { skillId: 'lyra', defaultSubcommand: 'headline' },
  '/repurpose':  { skillId: 'lyra', defaultSubcommand: 'repurpose' },

  // Lyra — Media Briefs (Phase 1b)
  '/image':      { skillId: 'lyra', defaultSubcommand: 'image' },
  '/imagine':    { skillId: 'lyra', defaultSubcommand: 'image' },
  '/video':      { skillId: 'lyra', defaultSubcommand: 'video' },
  '/storyboard': { skillId: 'lyra', defaultSubcommand: 'video' },

  // Spark — Brainstorm (Phase 2)
  '/save':      { skillId: 'spark', defaultSubcommand: 'save' },
  '/bookmark':  { skillId: 'spark', defaultSubcommand: 'save' },
  '/spark':     { skillId: 'spark', defaultSubcommand: 'spark' },
  '/gauntlet':  { skillId: 'spark', defaultSubcommand: 'gauntlet' },
  '/brainstorm': { skillId: 'spark', defaultSubcommand: 'brainstorm' },
  '/ideas':     { skillId: 'spark', defaultSubcommand: 'list' },

  // Nexus — Research (Phase 3)
  '/research':  { skillId: 'nexus', defaultSubcommand: 'research' },
  '/dossier':   { skillId: 'nexus', defaultSubcommand: 'dossier' },

  // Audit — Repo audit + RCA + CAPA (Phase 4, v0 Scout-only)
  '/audit':     { skillId: 'audit', defaultSubcommand: 'plan' },
};

/**
 * Look up a command string in the skill map.
 * Returns the mapping or undefined if the command isn't skill-routed.
 */
export function lookupCommand(command: string): CommandMapping | undefined {
  // Normalize: lowercase, strip trailing @botname
  const normalized = command.toLowerCase().replace(/@\S+$/, '');
  return COMMAND_SKILL_MAP[normalized];
}

// ---------------------------------------------------------------------------
// Flag parser
// ---------------------------------------------------------------------------

/**
 * Parse --key value flags from user input text.
 *
 * Supports:
 *   --key value        → { key: 'value' }
 *   --key "multi word" → { key: 'multi word' }
 *   --flag             → { flag: 'true' } (boolean flag)
 *
 * Returns { flags, rest } where `rest` is the input with flags stripped.
 */
export function parseFlags(input: string): { flags: Record<string, string>; rest: string } {
  const flags: Record<string, string> = {};
  // Match --key "quoted value" or --key unquoted_value or --key (boolean)
  const flagPattern = /--(\w[\w-]*)(?:\s+"([^"]+)"|\s+(?!--)(\S+))?/g;
  let rest = input;
  let match: RegExpExecArray | null;

  while ((match = flagPattern.exec(input)) !== null) {
    const key = match[1];
    const value = match[2] ?? match[3] ?? 'true';
    flags[key] = value;
    // Remove the matched flag from the rest
    rest = rest.replace(match[0], '');
  }

  // Clean up extra whitespace
  rest = rest.replace(/\s+/g, ' ').trim();

  return { flags, rest };
}

/**
 * Parse a full command message into skill routing info.
 *
 * Example: "/write --for twitter Check out this new feature"
 * → { command: '/write', subcommand: 'write', flags: { for: 'twitter' }, text: 'Check out this new feature' }
 */
export function parseCommandMessage(message: string): {
  command: string;
  subcommand: string;
  flags: Record<string, string>;
  text: string;
  mapping: CommandMapping;
} | null {
  const trimmed = message.trim();
  if (!trimmed.startsWith('/')) return null;

  // Extract command (first word)
  const spaceIdx = trimmed.indexOf(' ');
  const command = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const mapping = lookupCommand(command);
  if (!mapping) return null;

  // Rest of the message after the command
  const afterCommand = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

  // Parse flags from the remaining text
  const { flags, rest } = parseFlags(afterCommand);

  let subcommand = mapping.defaultSubcommand;
  let text = rest;

  // Subcommand detection: ONLY for skills that use a single entry command
  // with multiple subcommands (e.g. "/orch init", "/orch run", "/orch status").
  //
  // For skills where each command maps 1:1 to a subcommand (e.g. /write → write,
  // /headline → headline), we SKIP subcommand parsing to avoid misinterpreting
  // user content as a subcommand. Example: "/write headline ideas for X" should
  // NOT be parsed as subcommand="headline".
  const MULTI_SUBCOMMAND_SKILLS: Record<string, string[]> = {
    orchestra: ['init', 'run', 'redo', 'do', 'draft', 'next', 'status', 'history', 'plan', 'lock', 'unlock', 'health', 'reset'],
    // nexus: only /research and /dossier have modes (quick/decision/full),
    // but those are flags, not subcommands. Keep them as flags.
    audit: ['plan', 'run', 'export', 'suppress', 'unsuppress', 'fix'],
  };

  const subs = MULTI_SUBCOMMAND_SKILLS[mapping.skillId];
  if (subs) {
    const firstWord = rest.split(/\s+/)[0]?.toLowerCase() ?? '';
    if (firstWord && subs.includes(firstWord)) {
      subcommand = firstWord;
      text = rest.slice(firstWord.length).trim();
    }
  }

  return { command, subcommand, flags, text, mapping };
}
