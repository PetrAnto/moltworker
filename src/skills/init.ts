/**
 * Gecko Skills — Initialization
 *
 * Registers all available skills with the registry.
 * Import this module once at startup to ensure skills are registered.
 */

import { registerSkill } from './registry';
import { handleOrchestra, ORCHESTRA_META } from './orchestra/handler';

let initialized = false;

/** Register all built-in skills. Safe to call multiple times. */
export function initializeSkills(): void {
  if (initialized) return;
  initialized = true;

  registerSkill(ORCHESTRA_META, handleOrchestra);

  // Future phases will register here:
  // registerSkill(LYRA_META, handleLyra);       // Phase 1
  // registerSkill(SPARK_META, handleSpark);      // Phase 2
  // registerSkill(NEXUS_META, handleNexus);      // Phase 3
}
