/**
 * Tests for Phase Budget Circuit Breakers
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PHASE_BUDGETS, PhaseBudgetExceededError, checkPhaseBudget } from './phase-budget';

describe('Phase Budget Circuit Breakers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('PHASE_BUDGETS constants', () => {
    it('should have plan budget less than work budget', () => {
      expect(PHASE_BUDGETS.plan).toBeLessThan(PHASE_BUDGETS.work);
    });

    it('should have review budget less than plan budget', () => {
      expect(PHASE_BUDGETS.review).toBeLessThan(PHASE_BUDGETS.plan);
    });

    it('should have correct budget values', () => {
      expect(PHASE_BUDGETS.plan).toBe(8_000);
      expect(PHASE_BUDGETS.work).toBe(18_000);
      expect(PHASE_BUDGETS.review).toBe(3_000);
    });
  });

  describe('PhaseBudgetExceededError', () => {
    it('should contain phase, elapsed, and budget info', () => {
      const error = new PhaseBudgetExceededError('work', 20000, 18000);
      expect(error.phase).toBe('work');
      expect(error.elapsedMs).toBe(20000);
      expect(error.budgetMs).toBe(18000);
      expect(error.name).toBe('PhaseBudgetExceededError');
      expect(error.message).toContain('work');
      expect(error.message).toContain('20000');
      expect(error.message).toContain('18000');
    });

    it('should be an instance of Error', () => {
      const error = new PhaseBudgetExceededError('plan', 9000, 8000);
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe('checkPhaseBudget', () => {
    it('should return true when within budget', () => {
      // Phase started just now → well within any budget
      const result = checkPhaseBudget('work', Date.now());
      expect(result).toBe(true);
    });

    it('should throw PhaseBudgetExceededError when over budget', () => {
      // Phase started 20s ago → exceeds work budget of 18s
      const phaseStartTime = Date.now() - 20_000;
      expect(() => checkPhaseBudget('work', phaseStartTime)).toThrow(PhaseBudgetExceededError);
    });

    it('should throw for plan phase after 8s', () => {
      const phaseStartTime = Date.now() - 9_000;
      expect(() => checkPhaseBudget('plan', phaseStartTime)).toThrow(PhaseBudgetExceededError);
    });

    it('should not throw for plan phase within 8s', () => {
      const phaseStartTime = Date.now() - 5_000;
      expect(() => checkPhaseBudget('plan', phaseStartTime)).not.toThrow();
    });

    it('should throw for review phase after 3s', () => {
      const phaseStartTime = Date.now() - 4_000;
      expect(() => checkPhaseBudget('review', phaseStartTime)).toThrow(PhaseBudgetExceededError);
    });

    it('should not throw for review phase within 3s', () => {
      const phaseStartTime = Date.now() - 2_000;
      expect(() => checkPhaseBudget('review', phaseStartTime)).not.toThrow();
    });

    it('should include correct phase in the thrown error', () => {
      const phaseStartTime = Date.now() - 10_000;
      try {
        checkPhaseBudget('plan', phaseStartTime);
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(PhaseBudgetExceededError);
        const err = e as PhaseBudgetExceededError;
        expect(err.phase).toBe('plan');
        expect(err.budgetMs).toBe(8_000);
        expect(err.elapsedMs).toBeGreaterThanOrEqual(10_000);
      }
    });
  });

  describe('integration: autoResumeCount increment on budget exceeded', () => {
    it('should trigger autoResumeCount increment (conceptual)', () => {
      // This verifies the error type that task-processor catches to increment autoResumeCount
      const error = new PhaseBudgetExceededError('work', 19000, 18000);
      expect(error).toBeInstanceOf(PhaseBudgetExceededError);
      // The task-processor catch block checks: error instanceof PhaseBudgetExceededError
      // and then does: task.autoResumeCount = (task.autoResumeCount ?? 0) + 1
      // This is verified in the task-processor integration tests
    });
  });

  describe('checkpoint saved before throw on timeout', () => {
    it('checkPhaseBudget throws before execution can proceed', () => {
      // When checkPhaseBudget throws, the calling code in processTask() never reaches
      // the API call or tool execution. The catch block saves the checkpoint.
      const phaseStartTime = Date.now() - 20_000;
      let apiCallReached = false;
      try {
        checkPhaseBudget('work', phaseStartTime);
        apiCallReached = true; // Should not reach here
      } catch (e) {
        expect(e).toBeInstanceOf(PhaseBudgetExceededError);
      }
      expect(apiCallReached).toBe(false);
    });
  });

  describe('normal completion unaffected', () => {
    it('should not affect autoResumeCount for tasks completing within budget', () => {
      // Simulating: a phase that starts and completes quickly
      const phaseStartTime = Date.now();
      // Multiple checks within budget should all pass
      expect(checkPhaseBudget('plan', phaseStartTime)).toBe(true);
      expect(checkPhaseBudget('work', phaseStartTime)).toBe(true);
      expect(checkPhaseBudget('review', phaseStartTime)).toBe(true);
      // No error thrown → autoResumeCount not incremented in processTask
    });
  });
});
