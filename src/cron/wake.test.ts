import { describe, it, expect } from 'vitest';
import { shouldWakeContainer, DEFAULT_LEAD_TIME_MS } from './wake';

const NOW = 1700000000000; // Fixed timestamp for tests

function makeStore(jobs: Array<{
  id: string;
  enabled: boolean;
  schedule: { kind: string; [key: string]: unknown };
  state?: { nextRunAtMs?: number; runningAtMs?: number };
}>): string {
  return JSON.stringify({
    version: 1,
    jobs: jobs.map((j) => ({
      ...j,
      state: j.state ?? {},
    })),
  });
}

describe('shouldWakeContainer', () => {
  it('returns null when no jobs exist', () => {
    const store = makeStore([]);
    expect(shouldWakeContainer(store, NOW, DEFAULT_LEAD_TIME_MS)).toBeNull();
  });

  it('returns null when all jobs are disabled', () => {
    const store = makeStore([
      {
        id: 'j1',
        enabled: false,
        schedule: { kind: 'every', everyMs: 60000 },
        state: { nextRunAtMs: NOW + 5000 },
      },
    ]);
    expect(shouldWakeContainer(store, NOW, DEFAULT_LEAD_TIME_MS)).toBeNull();
  });

  it('returns earliest run time when a job is within lead time', () => {
    const nextRun = NOW + 5 * 60 * 1000; // 5 minutes from now
    const store = makeStore([
      {
        id: 'j1',
        enabled: true,
        schedule: { kind: 'every', everyMs: 60000 },
        state: { nextRunAtMs: nextRun },
      },
    ]);
    expect(shouldWakeContainer(store, NOW, DEFAULT_LEAD_TIME_MS)).toBe(nextRun);
  });

  it('returns null when job is outside lead time', () => {
    const nextRun = NOW + 20 * 60 * 1000; // 20 minutes from now
    const store = makeStore([
      {
        id: 'j1',
        enabled: true,
        schedule: { kind: 'every', everyMs: 60000 },
        state: { nextRunAtMs: nextRun },
      },
    ]);
    expect(shouldWakeContainer(store, NOW, DEFAULT_LEAD_TIME_MS)).toBeNull();
  });

  it('skips currently running jobs', () => {
    const store = makeStore([
      {
        id: 'j1',
        enabled: true,
        schedule: { kind: 'every', everyMs: 60000 },
        state: { nextRunAtMs: NOW + 5000, runningAtMs: NOW - 1000 },
      },
    ]);
    expect(shouldWakeContainer(store, NOW, DEFAULT_LEAD_TIME_MS)).toBeNull();
  });

  it('returns the earliest of multiple upcoming jobs', () => {
    const early = NOW + 3 * 60 * 1000;
    const late = NOW + 7 * 60 * 1000;
    const store = makeStore([
      {
        id: 'j1',
        enabled: true,
        schedule: { kind: 'every', everyMs: 60000 },
        state: { nextRunAtMs: late },
      },
      {
        id: 'j2',
        enabled: true,
        schedule: { kind: 'every', everyMs: 60000 },
        state: { nextRunAtMs: early },
      },
    ]);
    expect(shouldWakeContainer(store, NOW, DEFAULT_LEAD_TIME_MS)).toBe(early);
  });

  it('computes nextRunAtMs for "at" schedule when not stored', () => {
    const atTime = NOW + 5 * 60 * 1000;
    const store = makeStore([
      {
        id: 'j1',
        enabled: true,
        schedule: { kind: 'at', atMs: atTime },
      },
    ]);
    expect(shouldWakeContainer(store, NOW, DEFAULT_LEAD_TIME_MS)).toBe(atTime);
  });

  it('returns null for past "at" schedule', () => {
    const store = makeStore([
      {
        id: 'j1',
        enabled: true,
        schedule: { kind: 'at', atMs: NOW - 1000 },
      },
    ]);
    expect(shouldWakeContainer(store, NOW, DEFAULT_LEAD_TIME_MS)).toBeNull();
  });

  it('handles invalid JSON gracefully', () => {
    expect(() => shouldWakeContainer('invalid', NOW, DEFAULT_LEAD_TIME_MS)).toThrow();
  });

  it('handles empty jobs array', () => {
    const store = JSON.stringify({ version: 1, jobs: [] });
    expect(shouldWakeContainer(store, NOW, DEFAULT_LEAD_TIME_MS)).toBeNull();
  });
});
