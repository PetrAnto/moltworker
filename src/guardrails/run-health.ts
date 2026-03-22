/**
 * Run Health Scoring
 *
 * Distinguishes "task success" from "run health" by tracking platform-level
 * issues that occurred during execution. A task can succeed (valid PR created)
 * while the run was unhealthy (multiple resumes, auth errors, sandbox stalls).
 *
 * Health levels:
 *   GREEN  — clean run, no platform issues
 *   YELLOW — task succeeded but platform issues occurred
 *   RED    — task failed or severe platform degradation
 */

import type { ToolErrorTracker } from './tool-validator';

// ─── Types ──────────────────────────────────────────────────────────────────

export type RunHealthLevel = 'green' | 'yellow' | 'red';

export interface RunHealth {
  level: RunHealthLevel;
  /** One-word label for Telegram display */
  label: string;
  /** Emoji for the health level */
  emoji: string;
  /** Individual issue flags */
  issues: RunHealthIssue[];
  /** Structured summary for observability */
  summary: string;
}

export interface RunHealthIssue {
  category: 'resumes' | 'auth_errors' | 'sandbox_stall' | 'prefetch_404s' | 'tool_errors';
  detail: string;
  severity: 'warning' | 'critical';
}

// ─── SLO Thresholds ─────────────────────────────────────────────────────────

/** Resume count SLOs */
const RESUME_THRESHOLD_YELLOW = 2; // 2+ resumes = degraded
const RESUME_THRESHOLD_RED = 4;    // 4+ resumes = unhealthy

/** Auth error SLOs */
const AUTH_ERROR_THRESHOLD = 1;    // Any auth error = yellow

/** Tool error SLOs */
const TOOL_ERROR_THRESHOLD_YELLOW = 3; // 3+ total errors = yellow
const MUTATION_ERROR_THRESHOLD_RED = 2; // 2+ mutation errors = red

// ─── Health Computation ─────────────────────────────────────────────────────

export interface RunHealthInput {
  /** Number of auto-resumes during this run */
  resumeCount: number;
  /** Tool error tracker from the task session */
  toolErrors: ToolErrorTracker;
  /** Whether sandbox stagnation was detected (from tool results) */
  sandboxStalled: boolean;
  /** Number of prefetch 404 errors (from tool results) */
  prefetch404Count: number;
  /** Whether the task itself succeeded (PR created, deliverables met) */
  taskSucceeded: boolean;
}

/**
 * Compute run health from platform signals.
 * Task success/failure is separate from run health — a task can succeed
 * on an unhealthy run, and a task can fail on a healthy run (model error).
 */
export function computeRunHealth(input: RunHealthInput): RunHealth {
  const issues: RunHealthIssue[] = [];
  let worstLevel: RunHealthLevel = 'green';

  function escalate(level: RunHealthLevel): void {
    if (level === 'red') worstLevel = 'red';
    else if (level === 'yellow' && worstLevel !== 'red') worstLevel = 'yellow';
  }

  // 1. Resume count
  if (input.resumeCount >= RESUME_THRESHOLD_RED) {
    issues.push({
      category: 'resumes',
      detail: `${input.resumeCount} auto-resumes (unhealthy, SLO: <${RESUME_THRESHOLD_RED})`,
      severity: 'critical',
    });
    escalate('red');
  } else if (input.resumeCount >= RESUME_THRESHOLD_YELLOW) {
    issues.push({
      category: 'resumes',
      detail: `${input.resumeCount} auto-resumes (degraded, SLO: <${RESUME_THRESHOLD_YELLOW})`,
      severity: 'warning',
    });
    escalate('yellow');
  }

  // 2. Auth errors
  const authErrors = input.toolErrors.errors.filter(e => e.errorType === 'auth_error');
  if (authErrors.length >= AUTH_ERROR_THRESHOLD) {
    const tools = [...new Set(authErrors.map(e => e.tool))].join(', ');
    issues.push({
      category: 'auth_errors',
      detail: `${authErrors.length} auth error(s) on ${tools}`,
      severity: 'warning',
    });
    escalate('yellow');
  }

  // 3. Sandbox stall
  if (input.sandboxStalled) {
    issues.push({
      category: 'sandbox_stall',
      detail: 'sandbox process stalled (output unchanged, killed early)',
      severity: 'warning',
    });
    escalate('yellow');
  }

  // 4. Prefetch 404s
  if (input.prefetch404Count > 0) {
    issues.push({
      category: 'prefetch_404s',
      detail: `${input.prefetch404Count} prefetch 404 error(s)`,
      severity: 'warning',
    });
    escalate('yellow');
  }

  // 5. Tool errors (beyond auth — timeouts, http errors, etc.)
  if (input.toolErrors.mutationErrors >= MUTATION_ERROR_THRESHOLD_RED) {
    issues.push({
      category: 'tool_errors',
      detail: `${input.toolErrors.mutationErrors} mutation tool error(s)`,
      severity: 'critical',
    });
    escalate('red');
  } else if (input.toolErrors.totalErrors >= TOOL_ERROR_THRESHOLD_YELLOW) {
    issues.push({
      category: 'tool_errors',
      detail: `${input.toolErrors.totalErrors} tool error(s)`,
      severity: 'warning',
    });
    escalate('yellow');
  }

  // 6. Task failure itself doesn't change run health color —
  //    a model producing wrong code is not a platform issue.
  //    But if the task failed AND there are platform issues, stay red.

  const emoji = worstLevel === 'green' ? '🟢'
    : worstLevel === 'yellow' ? '🟡'
    : '🔴';

  const label = worstLevel === 'green' ? 'Clean'
    : worstLevel === 'yellow' ? 'Degraded'
    : 'Unhealthy';

  const summary = issues.length === 0
    ? 'No platform issues detected'
    : issues.map(i => `${i.severity === 'critical' ? '❌' : '⚠️'} ${i.detail}`).join('\n');

  return { level: worstLevel, label, emoji, issues, summary };
}

// ─── Formatting ─────────────────────────────────────────────────────────────

/**
 * Format run health as a structured footer for Telegram/ORCHESTRA_RESULT.
 * Compact format for appending to the final response.
 */
export function formatHealthFooter(health: RunHealth, resumeCount: number): string {
  const lines: string[] = [];
  lines.push(`${health.emoji} Run health: ${health.label}`);

  if (health.issues.length > 0) {
    for (const issue of health.issues) {
      lines.push(`  ${issue.severity === 'critical' ? '❌' : '⚠️'} ${issue.detail}`);
    }
  }

  if (resumeCount > 0) {
    lines.push(`  📊 Resumes: ${resumeCount}`);
  }

  return lines.join('\n');
}
