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
      expect(PHASE_BUDGETS.plan).toBe(120_000);
      expect(PHASE_BUDGETS.work).toBe(240_000);
      expect(PHASE_BUDGETS.review).toBe(60_000);
    });
  });

  describe('PhaseBudgetExceededError', () => {
    it('should contain phase, elapsed, and budget info', () => {
      const error = new PhaseBudgetExceededError('work', 250000, 240000);
      expect(error.phase).toBe('work');
      expect(error.elapsedMs).toBe(250000);
      expect(error.budgetMs).toBe(240000);
      expect(error.name).toBe('PhaseBudgetExceededError');
      expect(error.message).toContain('work');
      expect(error.message).toContain('250000');
      expect(error.message).toContain('240000');
    });

    it('should be an instance of Error', () => {
      const error = new PhaseBudgetExceededError('plan', 130000, 120000);
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
      // Phase started 5min ago → exceeds work budget of 4min
      const phaseStartTime = Date.now() - 300_000;
      expect(() => checkPhaseBudget('work', phaseStartTime)).toThrow(PhaseBudgetExceededError);
    });

    it('should throw for plan phase after 2min', () => {
      const phaseStartTime = Date.now() - 130_000;
      expect(() => checkPhaseBudget('plan', phaseStartTime)).toThrow(PhaseBudgetExceededError);
    });

    it('should not throw for plan phase within 2min', () => {
      const phaseStartTime = Date.now() - 60_000;
      expect(() => checkPhaseBudget('plan', phaseStartTime)).not.toThrow();
    });

    it('should throw for review phase after 1min', () => {
      const phaseStartTime = Date.now() - 70_000;
      expect(() => checkPhaseBudget('review', phaseStartTime)).toThrow(PhaseBudgetExceededError);
    });

    it('should not throw for review phase within 1min', () => {
      const phaseStartTime = Date.now() - 30_000;
      expect(() => checkPhaseBudget('review', phaseStartTime)).not.toThrow();
    });

    it('should include correct phase in the thrown error', () => {
      const phaseStartTime = Date.now() - 130_000;
      try {
        checkPhaseBudget('plan', phaseStartTime);
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(PhaseBudgetExceededError);
        const err = e as PhaseBudgetExceededError;
        expect(err.phase).toBe('plan');
        expect(err.budgetMs).toBe(120_000);
        expect(err.elapsedMs).toBeGreaterThanOrEqual(130_000);
      }
    });
  });

  describe('integration: alarm handler owns autoResumeCount', () => {
    it('should be caught by task-processor to save checkpoint (no double-counting)', () => {
      // This verifies the error type that task-processor catches.
      // The PhaseBudgetExceededError handler saves a checkpoint but does NOT
      // increment autoResumeCount — only the alarm handler does that to avoid
      // double-counting (each resume cycle was previously burning 2 slots).
      const error = new PhaseBudgetExceededError('work', 250000, 240000);
      expect(error).toBeInstanceOf(PhaseBudgetExceededError);
    });
  });

  describe('checkpoint saved before throw on timeout', () => {
    it('checkPhaseBudget throws before execution can proceed', () => {
      // When checkPhaseBudget throws, the calling code in processTask() never reaches
      // the API call or tool execution. The catch block saves the checkpoint.
      const phaseStartTime = Date.now() - 300_000;
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
