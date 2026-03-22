import { describe, it, expect } from 'vitest';
import { computeRunHealth, formatHealthFooter, type RunHealthInput } from './run-health';
import type { ToolErrorTracker } from './tool-validator';

function emptyTracker(): ToolErrorTracker {
  return { errors: [], mutationErrors: 0, totalErrors: 0 };
}

function trackerWithErrors(
  errors: Array<{ tool: string; errorType: 'auth_error' | 'timeout' | 'not_found' | 'generic_error'; iteration: number }>,
  mutationErrors = 0,
): ToolErrorTracker {
  return { errors, mutationErrors, totalErrors: errors.length };
}

function defaultInput(overrides?: Partial<RunHealthInput>): RunHealthInput {
  return {
    resumeCount: 0,
    toolErrors: emptyTracker(),
    sandboxStalled: false,
    prefetch404Count: 0,
    taskSucceeded: true,
    ...overrides,
  };
}

describe('computeRunHealth', () => {
  it('returns green for a clean run', () => {
    const health = computeRunHealth(defaultInput());
    expect(health.level).toBe('green');
    expect(health.issues).toHaveLength(0);
    expect(health.emoji).toBe('🟢');
    expect(health.label).toBe('Clean');
  });

  it('returns yellow for 2 resumes', () => {
    const health = computeRunHealth(defaultInput({ resumeCount: 2 }));
    expect(health.level).toBe('yellow');
    expect(health.issues).toHaveLength(1);
    expect(health.issues[0].category).toBe('resumes');
    expect(health.issues[0].severity).toBe('warning');
  });

  it('returns red for 4+ resumes', () => {
    const health = computeRunHealth(defaultInput({ resumeCount: 4 }));
    expect(health.level).toBe('red');
    expect(health.issues[0].severity).toBe('critical');
  });

  it('returns yellow for auth errors', () => {
    const health = computeRunHealth(defaultInput({
      toolErrors: trackerWithErrors([
        { tool: 'github_push_files', errorType: 'auth_error', iteration: 3 },
      ]),
    }));
    expect(health.level).toBe('yellow');
    expect(health.issues).toHaveLength(1);
    expect(health.issues[0].category).toBe('auth_errors');
  });

  it('returns yellow for sandbox stall', () => {
    const health = computeRunHealth(defaultInput({ sandboxStalled: true }));
    expect(health.level).toBe('yellow');
    expect(health.issues).toHaveLength(1);
    expect(health.issues[0].category).toBe('sandbox_stall');
  });

  it('returns yellow for prefetch 404s', () => {
    const health = computeRunHealth(defaultInput({ prefetch404Count: 2 }));
    expect(health.level).toBe('yellow');
    expect(health.issues[0].category).toBe('prefetch_404s');
  });

  it('returns red for 2+ mutation tool errors', () => {
    const health = computeRunHealth(defaultInput({
      toolErrors: trackerWithErrors([
        { tool: 'github_create_pr', errorType: 'generic_error', iteration: 5 },
        { tool: 'sandbox_exec', errorType: 'timeout', iteration: 7 },
      ], 2),
    }));
    expect(health.level).toBe('red');
    expect(health.issues.some(i => i.category === 'tool_errors' && i.severity === 'critical')).toBe(true);
  });

  it('returns yellow for 3+ total tool errors', () => {
    const health = computeRunHealth(defaultInput({
      toolErrors: trackerWithErrors([
        { tool: 'github_read_file', errorType: 'not_found', iteration: 1 },
        { tool: 'github_read_file', errorType: 'not_found', iteration: 2 },
        { tool: 'github_read_file', errorType: 'not_found', iteration: 3 },
      ], 0),
    }));
    expect(health.level).toBe('yellow');
    expect(health.issues.some(i => i.category === 'tool_errors')).toBe(true);
  });

  it('accumulates multiple issues', () => {
    const health = computeRunHealth(defaultInput({
      resumeCount: 3,
      sandboxStalled: true,
      prefetch404Count: 1,
      toolErrors: trackerWithErrors([
        { tool: 'workspace_commit', errorType: 'auth_error', iteration: 4 },
      ]),
    }));
    expect(health.level).toBe('yellow');
    expect(health.issues.length).toBeGreaterThanOrEqual(3);
  });

  it('red from resumes overrides yellow from other issues', () => {
    const health = computeRunHealth(defaultInput({
      resumeCount: 5,
      sandboxStalled: true,
    }));
    expect(health.level).toBe('red');
  });

  it('task failure does not change health level', () => {
    // A clean run where the model just produced bad code
    const health = computeRunHealth(defaultInput({ taskSucceeded: false }));
    expect(health.level).toBe('green');
  });
});

describe('formatHealthFooter', () => {
  it('formats green health', () => {
    const health = computeRunHealth(defaultInput());
    const footer = formatHealthFooter(health, 0);
    expect(footer).toContain('🟢');
    expect(footer).toContain('Clean');
  });

  it('formats yellow health with issues', () => {
    const health = computeRunHealth(defaultInput({ resumeCount: 2, sandboxStalled: true }));
    const footer = formatHealthFooter(health, 2);
    expect(footer).toContain('🟡');
    expect(footer).toContain('Degraded');
    expect(footer).toContain('Resumes: 2');
    expect(footer).toContain('sandbox');
  });

  it('formats red health with critical issues', () => {
    const health = computeRunHealth(defaultInput({ resumeCount: 5 }));
    const footer = formatHealthFooter(health, 5);
    expect(footer).toContain('🔴');
    expect(footer).toContain('Unhealthy');
    expect(footer).toContain('❌');
  });
});
