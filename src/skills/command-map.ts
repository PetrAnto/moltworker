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
  '/write':     { skillId: 'lyra', defaultSubcommand: 'write' },
  '/rewrite':   { skillId: 'lyra', defaultSubcommand: 'rewrite' },
  '/headline':  { skillId: 'lyra', defaultSubcommand: 'headline' },
  '/repurpose': { skillId: 'lyra', defaultSubcommand: 'repurpose' },

  // Spark — Brainstorm (Phase 2)
  '/save':      { skillId: 'spark', defaultSubcommand: 'save' },
  '/bookmark':  { skillId: 'spark', defaultSubcommand: 'save' },
  '/spark':     { skillId: 'spark', defaultSubcommand: 'spark' },
  '/gauntlet':  { skillId: 'spark', defaultSubcommand: 'gauntlet' },
  '/brainstorm': { skillId: 'spark', defaultSubcommand: 'brainstorm' },
  '/ideas':     { skillId: 'spark', defaultSubcommand: 'brainstorm' },

  // Nexus — Research (Phase 3)
  '/research':  { skillId: 'nexus', defaultSubcommand: 'research' },
  '/dossier':   { skillId: 'nexus', defaultSubcommand: 'dossier' },
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

  // Check if the first word of `rest` is a known subcommand
  // (e.g. "/orch init my project" → subcommand = 'init', text = 'my project')
  const firstWord = rest.split(/\s+/)[0]?.toLowerCase() ?? '';
  let subcommand = mapping.defaultSubcommand;
  let text = rest;

  // Simple heuristic: if first word looks like a subcommand (short, no special chars)
  // and the skill has multiple subcommands, treat it as one
  if (firstWord && /^[a-z]+$/.test(firstWord) && firstWord.length <= 12) {
    // For orchestra, known subcommands
    const orchSubcmds = ['init', 'run', 'redo', 'do', 'draft', 'next', 'status', 'history', 'plan', 'lock', 'unlock', 'health', 'reset'];
    const lyraSubcmds = ['write', 'rewrite', 'headline', 'repurpose'];
    const sparkSubcmds = ['save', 'spark', 'gauntlet', 'brainstorm', 'list'];
    const nexusSubcmds = ['research', 'dossier', 'quick', 'decision'];

    const knownSubs: Record<string, string[]> = {
      orchestra: orchSubcmds,
      lyra: lyraSubcmds,
      spark: sparkSubcmds,
      nexus: nexusSubcmds,
    };

    const subs = knownSubs[mapping.skillId] ?? [];
    if (subs.includes(firstWord)) {
      subcommand = firstWord;
      text = rest.slice(firstWord.length).trim();
    }
  }

  return { command, subcommand, flags, text, mapping };
}
