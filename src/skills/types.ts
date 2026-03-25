/**
 * Gecko Skills — Core Types
 *
 * Shared type definitions for the skill runtime.
 * Pure types with no external dependencies (except MoltbotEnv).
 */

import type { MoltbotEnv } from '../types';

// ---------------------------------------------------------------------------
// Skill identifiers
// ---------------------------------------------------------------------------

/** Known skill IDs. Extend as new skills are registered. */
export type SkillId = 'orchestra' | 'lyra' | 'spark' | 'nexus';

/** Transport the request originated from. */
export type Transport = 'telegram' | 'web' | 'api' | 'simulate';

// ---------------------------------------------------------------------------
// Skill request
// ---------------------------------------------------------------------------

/** Inbound request to execute a skill. */
export interface SkillRequest {
  /** Which skill to invoke. */
  skillId: SkillId;
  /** The subcommand within the skill (e.g. "init", "run" for orchestra). */
  subcommand: string;
  /** Raw user text after the command + subcommand. */
  text: string;
  /** Parsed flags from the user input (e.g. --for twitter → { for: 'twitter' }). */
  flags: Record<string, string>;
  /** Where the request came from. */
  transport: Transport;
  /** Opaque user ID (Telegram user ID, API caller, etc.). */
  userId: string;
  /** Chat/channel ID (for Telegram context). */
  chatId?: number;
  /** Model alias override (e.g. user picked a specific model). */
  modelAlias?: string;
  /** Worker environment bindings. */
  env: MoltbotEnv;
  /** Runtime-injected context (populated by runSkill, not by the caller). */
  context?: SkillContext;
}

/** Runtime context injected by runSkill() before the handler executes. */
export interface SkillContext {
  /** System prompt loaded from R2 (prompts/{skillId}/system.md), or undefined if not found. */
  hotPrompt?: string;
}

// ---------------------------------------------------------------------------
// Skill result
// ---------------------------------------------------------------------------

/**
 * Result kinds — each skill produces one of these.
 * Renderers use `kind` to decide formatting.
 */
export type SkillResultKind =
  | 'text'            // Plain text response
  | 'draft'           // Lyra draft artifact
  | 'headlines'       // Lyra headline variants
  | 'repurpose'       // Lyra repurposed content
  | 'capture_ack'     // Spark capture acknowledgement
  | 'digest'          // Spark inbox digest
  | 'gauntlet'        // Spark gauntlet result
  | 'dossier'         // Nexus research dossier
  | 'source_plan'     // Nexus HITL gate (awaiting approval)
  | 'orchestra'       // Orchestra result (PR link, roadmap, etc.)
  | 'error';          // Error response

/** Telemetry data attached to every skill result. */
export interface SkillTelemetry {
  /** Time spent executing the skill (ms). */
  durationMs: number;
  /** Model alias actually used. */
  model: string;
  /** Number of LLM calls made. */
  llmCalls: number;
  /** Number of tool calls made (if any). */
  toolCalls: number;
  /** Token usage (if available from the LLM response). */
  tokens?: {
    prompt: number;
    completion: number;
  };
}

/** The unified result every skill handler returns. */
export interface SkillResult {
  /** Which skill produced this result. */
  skillId: SkillId;
  /** The result kind — determines rendering. */
  kind: SkillResultKind;
  /** Primary text/markdown payload. */
  body: string;
  /** Optional structured data (JSON-serializable). */
  data?: unknown;
  /** Execution telemetry. */
  telemetry: SkillTelemetry;
}

// ---------------------------------------------------------------------------
// Skill handler
// ---------------------------------------------------------------------------

/** A skill handler processes a request and returns a result. */
export type SkillHandler = (request: SkillRequest) => Promise<SkillResult>;

// ---------------------------------------------------------------------------
// Skill metadata (for registry)
// ---------------------------------------------------------------------------

/** Static metadata about a registered skill. */
export interface SkillMeta {
  id: SkillId;
  name: string;
  description: string;
  /** Default model alias if none specified in the request. */
  defaultModel: string;
  /** Subcommands this skill supports. */
  subcommands: string[];
}
