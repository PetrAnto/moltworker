/**
 * Phase Budget Circuit Breakers
 *
 * Prevents Cloudflare DO 30s CPU hard-kill by enforcing per-phase
 * time budgets. When a phase exceeds its budget, a checkpoint is
 * saved and the task is thrown to let the watchdog alarm auto-resume.
 */

import type { TaskPhase } from './task-processor';
import type { Provider } from '../openrouter/models';

/**
 * Per-phase wall-clock time budgets in milliseconds.
 *
 * These prevent Cloudflare's 30s CPU hard-kill, but since Date.now()
 * measures wall-clock time (not CPU time), and most time is spent in
 * I/O waiting for LLM API responses (~10-30s per call), the budgets
 * must be much larger than the 30s CPU limit itself.
 *
 * Actual CPU usage per iteration is ~50-100ms (parsing, formatting).
 * Even 20 iterations × 100ms = 2s CPU, well under the 30s limit.
 *
 * The work budget was 4min, but slow models (qwennext ~45-60s per call)
 * only got 4-5 iterations before eviction. Increased to 8min to allow
 * 8-12 iterations per cycle, reducing the number of resume cycles needed.
 */
export const PHASE_BUDGETS: Record<TaskPhase, number> = {
  plan: 120_000,  // 2 min — planning needs a few LLM round-trips
  work: 480_000,  // 8 min — main work phase, multiple tool-calling iterations
  review: 90_000, // 1.5 min — review/summary needs ≥1 API call, slow models need more
};

/**
 * Provider-specific phase budget multipliers.
 * Slow providers (Moonshot/Kimi, DeepSeek) spend 60-90s per API call due to
 * deep reasoning before first token. Without scaling, they only get 5-8 work
 * iterations per phase, requiring 2-3 extra resume cycles that lose context.
 */
const PROVIDER_PHASE_MULTIPLIERS: Partial<Record<Provider, number>> = {
  moonshot: 2.0,  // Kimi: 60-90s per call → 16 min work phase
  deepseek: 1.5,  // DeepSeek: 40-60s per call → 12 min work phase
  dashscope: 1.3, // Qwen: 30-50s per call → ~10 min work phase
};

/**
 * Get the phase budget for a specific phase, optionally scaled by provider.
 */
export function getPhaseBudget(phase: TaskPhase, provider?: Provider): number {
  const base = PHASE_BUDGETS[phase];
  if (!provider) return base;
  const multiplier = PROVIDER_PHASE_MULTIPLIERS[provider] ?? 1.0;
  return Math.floor(base * multiplier);
}

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
 * @param provider - Optional provider for scaled budgets (slow providers get more time)
 * @returns true if still within budget, throws PhaseBudgetExceededError if over
 */
export function checkPhaseBudget(phase: TaskPhase, phaseStartTime: number, provider?: Provider): boolean {
  const elapsed = Date.now() - phaseStartTime;
  const budget = getPhaseBudget(phase, provider);
  if (elapsed > budget) {
    throw new PhaseBudgetExceededError(phase, elapsed, budget);
  }
  return true;
}
