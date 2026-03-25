/**
 * Gecko Skills — Initialization
 *
 * Registers all available skills with the registry.
 * Import this module once at startup to ensure skills are registered.
 */

import { registerSkill } from './registry';
import { handleOrchestra, ORCHESTRA_META } from './orchestra/handler';
import { handleLyra, LYRA_META } from './lyra/lyra';

let initialized = false;

/** Register all built-in skills. Safe to call multiple times. */
export function initializeSkills(): void {
  if (initialized) return;
  initialized = true;

  registerSkill(ORCHESTRA_META, handleOrchestra);
  registerSkill(LYRA_META, handleLyra);

  // Future phases will register here:
  // registerSkill(SPARK_META, handleSpark);      // Phase 2
  // registerSkill(NEXUS_META, handleNexus);      // Phase 3
}
