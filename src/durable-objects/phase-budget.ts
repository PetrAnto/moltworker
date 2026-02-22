/**
 * Phase Budget Circuit Breakers
 *
 * Prevents Cloudflare DO 30s CPU hard-kill by enforcing per-phase
 * time budgets. When a phase exceeds its budget, a checkpoint is
 * saved and the task is thrown to let the watchdog alarm auto-resume.
 */

import type { TaskPhase } from './task-processor';

/**
 * Per-phase wall-clock time budgets in milliseconds.
 *
 * These prevent Cloudflare's 30s CPU hard-kill, but since Date.now()
 * measures wall-clock time (not CPU time), and most time is spent in
 * I/O waiting for LLM API responses (~10-30s per call), the budgets
 * must be much larger than the 30s CPU limit itself.
 *
 * Actual CPU usage per iteration is ~50-100ms (parsing, formatting).
 * A 4-minute wall-clock budget allows ~10-15 slow-model iterations
 * while staying well under the 30s CPU limit.
 */
export const PHASE_BUDGETS: Record<TaskPhase, number> = {
  plan: 120_000,  // 2 min — planning needs a few LLM round-trips
  work: 240_000,  // 4 min — main work phase, multiple tool-calling iterations
  review: 60_000, // 1 min — review/summary is quick but needs ≥1 API call
};

/**
 * Error thrown when a phase budget is exceeded.
 * The watchdog alarm handler will auto-resume the task.
 */
export class PhaseBudgetExceededError extends Error {
  constructor(
    public readonly phase: TaskPhase,
    public readonly elapsedMs: number,
    public readonly budgetMs: number,
  ) {
    super(
      `Phase "${phase}" budget exceeded: ${elapsedMs}ms > ${budgetMs}ms — saving checkpoint for auto-resume`,
    );
    this.name = 'PhaseBudgetExceededError';
  }
}

/**
 * Check if the current phase has exceeded its time budget.
 * Call this before each API call or tool execution within the main loop.
 *
 * @param phase - Current task phase
 * @param phaseStartTime - Date.now() timestamp when this phase began
 * @returns true if still within budget, throws PhaseBudgetExceededError if over
 */
export function checkPhaseBudget(phase: TaskPhase, phaseStartTime: number): boolean {
  const elapsed = Date.now() - phaseStartTime;
  const budget = PHASE_BUDGETS[phase];
  if (elapsed > budget) {
    throw new PhaseBudgetExceededError(phase, elapsed, budget);
  }
  return true;
}
