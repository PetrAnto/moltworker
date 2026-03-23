/**
 * Tests for Branch-Level Concurrency Mutex (F.23)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  acquireRepoLock,
  releaseRepoLock,
  getRepoLock,
  forceReleaseRepoLock,
  lockKey,
  type RepoLock,
} from './branch-lock';

// ── Mock R2 Bucket ──────────────────────────────────────────────────────

class MockR2Bucket {
  private store = new Map<string, string>();

  async get(key: string): Promise<{ json: () => Promise<unknown> } | null> {
    const data = this.store.get(key);
    if (!data) return null;
    return { json: async () => JSON.parse(data) };
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  /** Test helper: read raw lock data */
  getRaw(key: string): RepoLock | null {
    const data = this.store.get(key);
    return data ? JSON.parse(data) : null;
  }

  /** Test helper: check if key exists */
  has(key: string): boolean {
    return this.store.has(key);
  }
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('branch-lock', () => {
  let r2: MockR2Bucket;

  beforeEach(() => {
    r2 = new MockR2Bucket();
  });

  // ── lockKey ─────────────────────────────────────────────────────────

  describe('lockKey', () => {
    it('builds correct R2 key', () => {
      expect(lockKey('user1', 'owner/repo')).toBe('branch-locks/user1/owner/repo.json');
    });

    it('normalizes repo to lowercase', () => {
      expect(lockKey('user1', 'Owner/Repo')).toBe('branch-locks/user1/owner/repo.json');
    });

    it('strips trailing slashes', () => {
      expect(lockKey('user1', 'owner/repo/')).toBe('branch-locks/user1/owner/repo.json');
    });
  });

  // ── acquireRepoLock ─────────────────────────────────────────────────

  describe('acquireRepoLock', () => {
    it('acquires lock when no existing lock', async () => {
      const result = await acquireRepoLock(
        r2 as unknown as R2Bucket, 'user1', 'owner/repo', 'task-1', 'bot/feature-deep-abc1'
      );

      expect(result.acquired).toBe(true);
      expect(result.existingLock).toBeUndefined();

      // Verify lock was written to R2
      const stored = r2.getRaw(lockKey('user1', 'owner/repo'));
      expect(stored).not.toBeNull();
      expect(stored!.taskId).toBe('task-1');
      expect(stored!.branchName).toBe('bot/feature-deep-abc1');
      expect(stored!.repo).toBe('owner/repo');
    });

    it('rejects when active lock exists', async () => {
      // First acquire succeeds
      await acquireRepoLock(
        r2 as unknown as R2Bucket, 'user1', 'owner/repo', 'task-1', 'bot/branch-1'
      );

      // Second acquire for same repo fails
      const result = await acquireRepoLock(
        r2 as unknown as R2Bucket, 'user1', 'owner/repo', 'task-2', 'bot/branch-2'
      );

      expect(result.acquired).toBe(false);
      expect(result.existingLock).toBeDefined();
      expect(result.existingLock!.taskId).toBe('task-1');
    });

    it('acquires when existing lock is expired', async () => {
      // Write an expired lock (acquired 50 min ago, TTL 45 min)
      const expiredLock: RepoLock = {
        taskId: 'old-task',
        userId: 'user1',
        repo: 'owner/repo',
        branchName: 'bot/old-branch',
        acquiredAt: Date.now() - 50 * 60 * 1000,
        ttlMs: 45 * 60 * 1000,
      };
      await r2.put(lockKey('user1', 'owner/repo'), JSON.stringify(expiredLock));

      // New acquire should succeed
      const result = await acquireRepoLock(
        r2 as unknown as R2Bucket, 'user1', 'owner/repo', 'task-new', 'bot/new-branch'
      );

      expect(result.acquired).toBe(true);
      const stored = r2.getRaw(lockKey('user1', 'owner/repo'));
      expect(stored!.taskId).toBe('task-new');
    });

    it('different repos have independent locks', async () => {
      await acquireRepoLock(
        r2 as unknown as R2Bucket, 'user1', 'owner/repo-a', 'task-1', 'bot/branch-1'
      );

      const result = await acquireRepoLock(
        r2 as unknown as R2Bucket, 'user1', 'owner/repo-b', 'task-2', 'bot/branch-2'
      );

      expect(result.acquired).toBe(true);
    });

    it('different users have independent locks for same repo', async () => {
      await acquireRepoLock(
        r2 as unknown as R2Bucket, 'user1', 'owner/repo', 'task-1', 'bot/branch-1'
      );

      const result = await acquireRepoLock(
        r2 as unknown as R2Bucket, 'user2', 'owner/repo', 'task-2', 'bot/branch-2'
      );

      expect(result.acquired).toBe(true);
    });

    it('handles corrupted lock data gracefully', async () => {
      // Write invalid JSON
      await r2.put(lockKey('user1', 'owner/repo'), '{invalid json');

      const result = await acquireRepoLock(
        r2 as unknown as R2Bucket, 'user1', 'owner/repo', 'task-1', 'bot/branch-1'
      );

      // Should succeed since corrupted lock is treated as absent
      expect(result.acquired).toBe(true);
    });
  });

  // ── releaseRepoLock ─────────────────────────────────────────────────

  describe('releaseRepoLock', () => {
    it('releases lock owned by the given task', async () => {
      await acquireRepoLock(
        r2 as unknown as R2Bucket, 'user1', 'owner/repo', 'task-1', 'bot/branch-1'
      );

      const released = await releaseRepoLock(
        r2 as unknown as R2Bucket, 'user1', 'owner/repo', 'task-1'
      );

      expect(released).toBe(true);
      expect(r2.has(lockKey('user1', 'owner/repo'))).toBe(false);
    });

    it('refuses to release lock owned by different task', async () => {
      await acquireRepoLock(
        r2 as unknown as R2Bucket, 'user1', 'owner/repo', 'task-1', 'bot/branch-1'
      );

      const released = await releaseRepoLock(
        r2 as unknown as R2Bucket, 'user1', 'owner/repo', 'task-WRONG'
      );

      expect(released).toBe(false);
      // Lock should still exist
      expect(r2.has(lockKey('user1', 'owner/repo'))).toBe(true);
    });

    it('returns false when no lock exists', async () => {
      const released = await releaseRepoLock(
        r2 as unknown as R2Bucket, 'user1', 'owner/repo', 'task-1'
      );

      expect(released).toBe(false);
    });

    it('is idempotent — second release returns false', async () => {
      await acquireRepoLock(
        r2 as unknown as R2Bucket, 'user1', 'owner/repo', 'task-1', 'bot/branch-1'
      );

      await releaseRepoLock(r2 as unknown as R2Bucket, 'user1', 'owner/repo', 'task-1');
      const second = await releaseRepoLock(r2 as unknown as R2Bucket, 'user1', 'owner/repo', 'task-1');

      expect(second).toBe(false);
    });
  });

  // ── getRepoLock ─────────────────────────────────────────────────────

  describe('getRepoLock', () => {
    it('returns active lock', async () => {
      await acquireRepoLock(
        r2 as unknown as R2Bucket, 'user1', 'owner/repo', 'task-1', 'bot/branch-1'
      );

      const lock = await getRepoLock(r2 as unknown as R2Bucket, 'user1', 'owner/repo');

      expect(lock).not.toBeNull();
      expect(lock!.taskId).toBe('task-1');
    });

    it('returns null for expired lock and cleans up', async () => {
      const expiredLock: RepoLock = {
        taskId: 'old-task',
        userId: 'user1',
        repo: 'owner/repo',
        branchName: 'bot/old-branch',
        acquiredAt: Date.now() - 50 * 60 * 1000,
        ttlMs: 45 * 60 * 1000,
      };
      await r2.put(lockKey('user1', 'owner/repo'), JSON.stringify(expiredLock));

      const lock = await getRepoLock(r2 as unknown as R2Bucket, 'user1', 'owner/repo');

      expect(lock).toBeNull();
      // Should have cleaned up the expired lock
      expect(r2.has(lockKey('user1', 'owner/repo'))).toBe(false);
    });

    it('returns null when no lock exists', async () => {
      const lock = await getRepoLock(r2 as unknown as R2Bucket, 'user1', 'owner/repo');
      expect(lock).toBeNull();
    });
  });

  // ── forceReleaseRepoLock ────────────────────────────────────────────

  describe('forceReleaseRepoLock', () => {
    it('releases regardless of ownership', async () => {
      await acquireRepoLock(
        r2 as unknown as R2Bucket, 'user1', 'owner/repo', 'task-1', 'bot/branch-1'
      );

      const released = await forceReleaseRepoLock(
        r2 as unknown as R2Bucket, 'user1', 'owner/repo'
      );

      expect(released).toBe(true);
      expect(r2.has(lockKey('user1', 'owner/repo'))).toBe(false);
    });

    it('succeeds even when no lock exists', async () => {
      const released = await forceReleaseRepoLock(
        r2 as unknown as R2Bucket, 'user1', 'owner/repo'
      );
      expect(released).toBe(true);
    });
  });

  // ── Integration scenarios ───────────────────────────────────────────

  describe('integration', () => {
    it('full lifecycle: acquire → release → re-acquire', async () => {
      const bucket = r2 as unknown as R2Bucket;

      // Task 1 acquires
      const r1 = await acquireRepoLock(bucket, 'user1', 'o/r', 'task-1', 'bot/b1');
      expect(r1.acquired).toBe(true);

      // Task 2 blocked
      const r2a = await acquireRepoLock(bucket, 'user1', 'o/r', 'task-2', 'bot/b2');
      expect(r2a.acquired).toBe(false);

      // Task 1 releases
      await releaseRepoLock(bucket, 'user1', 'o/r', 'task-1');

      // Task 2 can now acquire
      const r2b = await acquireRepoLock(bucket, 'user1', 'o/r', 'task-2', 'bot/b2');
      expect(r2b.acquired).toBe(true);
    });

    it('lock shows elapsed time for blocked user', async () => {
      const bucket = r2 as unknown as R2Bucket;

      // Acquire with known timestamp
      const lockData: RepoLock = {
        taskId: 'task-1',
        userId: 'user1',
        repo: 'o/r',
        branchName: 'bot/feature-deep-abc1',
        acquiredAt: Date.now() - 5 * 60 * 1000, // 5 min ago
        ttlMs: 45 * 60 * 1000,
      };
      await (bucket as unknown as MockR2Bucket).put(lockKey('user1', 'o/r'), JSON.stringify(lockData));

      // Second task sees the lock details
      const result = await acquireRepoLock(bucket, 'user1', 'o/r', 'task-2', 'bot/b2');
      expect(result.acquired).toBe(false);
      expect(result.existingLock!.branchName).toBe('bot/feature-deep-abc1');

      // Caller can compute elapsed time
      const elapsedMin = Math.round((Date.now() - result.existingLock!.acquiredAt) / 60000);
      expect(elapsedMin).toBeGreaterThanOrEqual(4); // ~5 min
      expect(elapsedMin).toBeLessThanOrEqual(6);
    });

    it('cancel scenario: force-release allows new task', async () => {
      const bucket = r2 as unknown as R2Bucket;

      await acquireRepoLock(bucket, 'user1', 'o/r', 'task-1', 'bot/b1');

      // User cancels — force release
      await forceReleaseRepoLock(bucket, 'user1', 'o/r');

      // New task can acquire immediately
      const result = await acquireRepoLock(bucket, 'user1', 'o/r', 'task-2', 'bot/b2');
      expect(result.acquired).toBe(true);
    });
  });
});
