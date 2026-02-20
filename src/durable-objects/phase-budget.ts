/**
 * Phase Budget Circuit Breakers
 *
 * Prevents Cloudflare DO 30s CPU hard-kill by enforcing per-phase
 * time budgets. When a phase exceeds its budget, a checkpoint is
 * saved and the task is thrown to let the watchdog alarm auto-resume.
 */

import type { TaskPhase } from './task-processor';

/** Per-phase CPU time budgets in milliseconds. plan < work, review < plan. */
export const PHASE_BUDGETS: Record<TaskPhase, number> = {
  plan: 8_000,
  work: 18_000,
  review: 3_000,
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
