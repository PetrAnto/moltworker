/**
 * Gecko Skills — Registry
 *
 * Central registry of skill handlers and their metadata.
 * Initially only orchestra is registered; future phases add lyra, spark, nexus.
 */

import type { SkillId, SkillHandler, SkillMeta } from './types';

// ---------------------------------------------------------------------------
// Handler registry
// ---------------------------------------------------------------------------

const handlers = new Map<SkillId, SkillHandler>();
const metadata = new Map<SkillId, SkillMeta>();

/** Register a skill handler with its metadata. */
export function registerSkill(meta: SkillMeta, handler: SkillHandler): void {
  handlers.set(meta.id, handler);
  metadata.set(meta.id, meta);
}

/** Get a registered skill handler. Returns undefined if not registered. */
export function getSkillHandler(id: SkillId): SkillHandler | undefined {
  return handlers.get(id);
}

/** Get metadata for a registered skill. */
export function getSkillMeta(id: SkillId): SkillMeta | undefined {
  return metadata.get(id);
}

/** List all registered skill IDs. */
export function listRegisteredSkills(): SkillId[] {
  return Array.from(handlers.keys());
}

/** Check if a skill is registered. */
export function isSkillRegistered(id: SkillId): boolean {
  return handlers.has(id);
}
