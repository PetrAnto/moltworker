/**
 * Branch-Level Concurrency Mutex (F.23)
 *
 * Prevents parallel orchestra tasks from colliding on the same repo.
 * Uses R2 for persistent, cross-DO lock storage with TTL-based expiry.
 *
 * Scope: per-user, per-repo — one active orchestra task per user per repo.
 * This prevents branch collisions and conflicting ROADMAP.md/WORK_LOG.md edits.
 */

/** Lock state persisted in R2. */
export interface RepoLock {
  taskId: string;
  userId: string;
  repo: string;        // owner/repo
  branchName: string;  // The branch being worked on
  acquiredAt: number;  // Date.now() when lock was acquired
  ttlMs: number;       // Lock duration before auto-expiry
}

/** Result of an acquire attempt. */
export interface AcquireResult {
  acquired: boolean;
  existingLock?: RepoLock;
}

/**
 * Lock TTL: 45 minutes.
 * Aligned with the DO stale task threshold (30 min) + buffer for long-running tasks.
 * cleanupStaleTasks marks tasks as failed at 30 min; the lock expires 15 min later
 * to ensure the lock always outlives the stale cleanup window.
 */
const LOCK_TTL_MS = 45 * 60 * 1000;

/** Build the R2 key for a repo lock. */
export function lockKey(userId: string, repo: string): string {
  // Normalize repo to prevent subtle key mismatches (e.g. trailing slashes)
  const normalized = repo.toLowerCase().replace(/\/+$/, '');
  return `branch-locks/${userId}/${normalized}.json`;
}

/**
 * Check if an existing lock is still active (not expired).
 */
function isLockActive(lock: RepoLock, now: number = Date.now()): boolean {
  return now - lock.acquiredAt < lock.ttlMs;
}

/**
 * Acquire a repo-level lock before dispatching an orchestra task.
 *
 * If a lock already exists and hasn't expired, the acquire fails and returns
 * the existing lock so the caller can show a helpful message.
 *
 * Note: R2 doesn't support atomic compare-and-swap, but this is safe because:
 * - Webhook handling is serialized per-user in the Telegram handler
 * - The window between read and write is <10ms (single R2 round-trip)
 * - Even in the worst case (two requests slip through), the second task would
 *   get a different branch name (timestamp-based suffix), so the collision
 *   would be caught and one task would fail gracefully
 */
export async function acquireRepoLock(
  r2: R2Bucket,
  userId: string,
  repo: string,
  taskId: string,
  branchName: string,
): Promise<AcquireResult> {
  const key = lockKey(userId, repo);

  // Check for existing lock
  try {
    const obj = await r2.get(key);
    if (obj) {
      const existing = await obj.json() as RepoLock;
      if (isLockActive(existing)) {
        return { acquired: false, existingLock: existing };
      }
      // Expired — safe to overwrite
      console.log(`[BranchLock] Expired lock for ${repo} (task ${existing.taskId}, ${Math.round((Date.now() - existing.acquiredAt) / 60000)}min old)`);
    }
  } catch {
    // No lock or corrupted data — safe to acquire
  }

  const lock: RepoLock = {
    taskId,
    userId,
    repo,
    branchName,
    acquiredAt: Date.now(),
    ttlMs: LOCK_TTL_MS,
  };

  await r2.put(key, JSON.stringify(lock));
  console.log(`[BranchLock] Acquired lock for ${repo} (task ${taskId}, branch ${branchName})`);
  return { acquired: true };
}

/**
 * Release a repo lock after task completion or failure.
 *
 * Only releases if the given taskId owns the lock — prevents a stale cleanup
 * from accidentally releasing a newer task's lock.
 *
 * @returns true if the lock was released, false if not found or owned by another task.
 */
export async function releaseRepoLock(
  r2: R2Bucket,
  userId: string,
  repo: string,
  taskId: string,
): Promise<boolean> {
  const key = lockKey(userId, repo);

  try {
    const obj = await r2.get(key);
    if (!obj) return false;

    const existing = await obj.json() as RepoLock;
    if (existing.taskId !== taskId) {
      console.log(`[BranchLock] Skip release for ${repo}: lock owned by ${existing.taskId}, not ${taskId}`);
      return false;
    }

    await r2.delete(key);
    console.log(`[BranchLock] Released lock for ${repo} (task ${taskId})`);
    return true;
  } catch {
    // Best-effort: if we can't read the lock, try to delete it anyway
    // to prevent permanent deadlocks from corrupted lock files
    try {
      await r2.delete(key);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Get the current lock for a repo (if active).
 * Used for status checks and diagnostics.
 */
export async function getRepoLock(
  r2: R2Bucket,
  userId: string,
  repo: string,
): Promise<RepoLock | null> {
  const key = lockKey(userId, repo);

  try {
    const obj = await r2.get(key);
    if (!obj) return null;

    const lock = await obj.json() as RepoLock;
    if (!isLockActive(lock)) {
      // Expired — clean up opportunistically
      await r2.delete(key).catch(() => {});
      return null;
    }
    return lock;
  } catch {
    return null;
  }
}

/**
 * Force-release a lock regardless of ownership.
 * Used by /cancel to immediately free the repo for new tasks.
 */
export async function forceReleaseRepoLock(
  r2: R2Bucket,
  userId: string,
  repo: string,
): Promise<boolean> {
  const key = lockKey(userId, repo);
  try {
    await r2.delete(key);
    console.log(`[BranchLock] Force-released lock for ${repo}`);
    return true;
  } catch {
    return false;
  }
}
