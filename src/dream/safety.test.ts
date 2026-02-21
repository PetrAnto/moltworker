import { describe, it, expect } from 'vitest';
import { checkBudget, checkDestructiveOps, checkBranchSafety, validateJob } from './safety';
import type { DreamBuildJob, WorkItem } from './types';

function makeJob(overrides?: Partial<DreamBuildJob>): DreamBuildJob {
  return {
    jobId: 'job-123',
    specId: 'spec-456',
    userId: 'user-789',
    targetRepoType: 'custom',
    repoOwner: 'PetrAnto',
    repoName: 'test-repo',
    baseBranch: 'main',
    branchPrefix: 'dream/',
    specMarkdown: '# Test Spec\n\n## Requirements\n- Feature A',
    estimatedEffort: '4h',
    priority: 'medium',
    callbackUrl: 'https://storia.ai/api/dream-callback',
    budget: { maxTokens: 100000, maxDollars: 5.0 },
    ...overrides,
  };
}

describe('checkBudget', () => {
  const budget = { maxTokens: 100000, maxDollars: 5.0 };

  it('should allow within budget', () => {
    const result = checkBudget(50000, 2.5, budget);
    expect(result.allowed).toBe(true);
  });

  it('should reject when tokens exceeded', () => {
    const result = checkBudget(150000, 2.5, budget);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Token budget exceeded');
  });

  it('should reject when cost exceeded', () => {
    const result = checkBudget(50000, 7.5, budget);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Cost budget exceeded');
  });

  it('should allow at exact budget', () => {
    const result = checkBudget(100000, 5.0, budget);
    expect(result.allowed).toBe(true);
  });
});

describe('checkDestructiveOps', () => {
  it('should allow safe operations', () => {
    const items: WorkItem[] = [
      { path: 'src/app.ts', content: 'console.log("hello")', description: 'Safe file' },
      { path: 'src/db.ts', content: 'SELECT * FROM users', description: 'Read query' },
    ];
    const result = checkDestructiveOps(items);
    expect(result.allowed).toBe(true);
  });

  it('should flag DROP TABLE', () => {
    const items: WorkItem[] = [
      { path: 'migration.sql', content: 'DROP TABLE users;', description: 'Migration' },
    ];
    const result = checkDestructiveOps(items);
    expect(result.allowed).toBe(false);
    expect(result.flaggedItems).toHaveLength(1);
    expect(result.flaggedItems![0]).toContain('migration.sql');
  });

  it('should flag TRUNCATE TABLE', () => {
    const items: WorkItem[] = [
      { path: 'clean.sql', content: 'TRUNCATE TABLE sessions;', description: 'Cleanup' },
    ];
    const result = checkDestructiveOps(items);
    expect(result.allowed).toBe(false);
  });

  it('should flag rm -rf', () => {
    const items: WorkItem[] = [
      { path: 'deploy.sh', content: 'rm -rf /tmp/build', description: 'Deploy script' },
    ];
    const result = checkDestructiveOps(items);
    expect(result.allowed).toBe(false);
  });

  it('should flag DELETE without WHERE', () => {
    const items: WorkItem[] = [
      { path: 'clean.sql', content: 'DELETE FROM logs;', description: 'Purge' },
    ];
    const result = checkDestructiveOps(items);
    expect(result.allowed).toBe(false);
  });
});

describe('checkBranchSafety', () => {
  it('should allow dream branches', () => {
    expect(checkBranchSafety('dream/mobile-ux').allowed).toBe(true);
  });

  it('should block main', () => {
    const result = checkBranchSafety('main');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('protected branch');
  });

  it('should block master', () => {
    expect(checkBranchSafety('master').allowed).toBe(false);
  });

  it('should block production', () => {
    expect(checkBranchSafety('production').allowed).toBe(false);
  });

  it('should block staging', () => {
    expect(checkBranchSafety('staging').allowed).toBe(false);
  });

  it('should be case-insensitive', () => {
    expect(checkBranchSafety('MAIN').allowed).toBe(false);
    expect(checkBranchSafety('Main').allowed).toBe(false);
  });
});

describe('validateJob', () => {
  it('should accept valid job', () => {
    const result = validateJob(makeJob());
    expect(result.allowed).toBe(true);
  });

  it('should reject missing jobId', () => {
    const result = validateJob(makeJob({ jobId: '' }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Missing required job fields');
  });

  it('should reject missing repoOwner', () => {
    const result = validateJob(makeJob({ repoOwner: '' }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Missing repository info');
  });

  it('should reject empty spec', () => {
    const result = validateJob(makeJob({ specMarkdown: '' }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('empty');
  });

  it('should reject missing callbackUrl', () => {
    const result = validateJob(makeJob({ callbackUrl: '' }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('callbackUrl');
  });

  it('should reject non-HTTPS callbackUrl', () => {
    const result = validateJob(makeJob({ callbackUrl: 'http://insecure.com/callback' }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('HTTPS');
  });

  it('should reject invalid repoOwner format', () => {
    const result = validateJob(makeJob({ repoOwner: 'bad owner!' }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Invalid repoOwner');
  });

  it('should reject zero budget', () => {
    const result = validateJob(makeJob({ budget: { maxTokens: 0, maxDollars: 5.0 } }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('budget');
  });
});
