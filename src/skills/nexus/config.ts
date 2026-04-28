/**
 * Nexus — pipeline budget constants.
 *
 * Single source of truth for every timeout and size limit in the dossier
 * pipeline. Tests reference these exports so literals can't drift.
 */

/** Max wall-clock ms to wait for a single source fetch. */
export const SOURCE_FETCH_TIMEOUT_MS = 30_000;

/** Max ms for the classifier LLM call (fast JSON response). */
export const CLASSIFY_LLM_TIMEOUT_MS = 45_000;

/** Max ms for the synthesis LLM call (larger evidence payload). */
export const SYNTHESIS_LLM_TIMEOUT_MS = 90_000;

/** Total evidence character budget sent to the synthesis prompt. */
export const MAX_EVIDENCE_CHARS = 12_000;

/** Maximum keyword tokens sent to keyword-strict APIs. */
export const MAX_KEYWORD_TOKENS = 4;
