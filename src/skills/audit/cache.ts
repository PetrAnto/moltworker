/**
 * Audit Skill — Profile Cache (NEXUS_KV)
 *
 * Caches `RepoProfile` by (owner, repo, sha). Same SHA → identical Scout
 * output, so this is a perfect content-addressed cache. TTL is generous
 * (24h) since the SHA itself is the cache-busting signal.
 */

import type { AuditRun, RepoProfile } from './types';

const CACHE_TTL_SECONDS = 24 * 60 * 60;
const CACHE_PREFIX = 'audit:profile:';

/** AuditRun storage TTL — long enough to survive a busy week of follow-ups
 *  via /audit export, short enough to not turn KV into a permanent
 *  archive. Aligns with most CI artifact retention policies. */
const RUN_TTL_SECONDS = 7 * 24 * 60 * 60;
const RUN_PREFIX = 'audit:run:';

/** Cache key for a profile pinned to a commit SHA. */
export function profileCacheKey(owner: string, repo: string, sha: string): string {
  return `${CACHE_PREFIX}${owner.toLowerCase()}/${repo.toLowerCase()}@${sha}`;
}

export async function getCachedProfile(
  kv: KVNamespace | undefined,
  owner: string,
  repo: string,
  sha: string,
): Promise<RepoProfile | null> {
  if (!kv) return null;
  try {
    return (await kv.get(profileCacheKey(owner, repo, sha), 'json')) as RepoProfile | null;
  } catch {
    return null;
  }
}

export async function cacheProfile(
  kv: KVNamespace | undefined,
  profile: RepoProfile,
): Promise<void> {
  if (!kv) return;
  try {
    await kv.put(
      profileCacheKey(profile.owner, profile.repo, profile.sha),
      JSON.stringify(profile),
      { expirationTtl: CACHE_TTL_SECONDS },
    );
  } catch (err) {
    console.warn('[Audit] cacheProfile failed:', err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------------
// AuditRun storage (used by /audit export <runId>)
// ---------------------------------------------------------------------------

/**
 * KV key for a persisted AuditRun. Run ids are UUIDs; collisions are
 * effectively impossible, but we still namespace under audit:run: so a
 * future `kv list` can sweep them. The user portion is folded in for two
 * reasons: (1) trivially scopes one user's data away from another's keyspace,
 * (2) export will reject a runId that doesn't match the requesting user
 * (defense against runId-guessing).
 */
export function runCacheKey(userId: string, runId: string): string {
  return `${RUN_PREFIX}${userId}:${runId}`;
}

export async function cacheAuditRun(
  kv: KVNamespace | undefined,
  userId: string,
  run: AuditRun,
): Promise<void> {
  if (!kv) return;
  try {
    await kv.put(
      runCacheKey(userId, run.runId),
      JSON.stringify(run),
      { expirationTtl: RUN_TTL_SECONDS },
    );
  } catch (err) {
    console.warn('[Audit] cacheAuditRun failed:', err instanceof Error ? err.message : err);
  }
}

export async function getCachedAuditRun(
  kv: KVNamespace | undefined,
  userId: string,
  runId: string,
): Promise<AuditRun | null> {
  if (!kv) return null;
  try {
    return (await kv.get(runCacheKey(userId, runId), 'json')) as AuditRun | null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Suppression list (per-user-per-repo)
// ---------------------------------------------------------------------------

/**
 * Stored shape: { ids: string[], updatedAt: ISO }. Array (not Set) so the
 * JSON roundtrips cleanly through KV. The set semantic is enforced at the
 * helper boundary — duplicates are deduped on add.
 */
interface SuppressionList {
  ids: string[];
  updatedAt: string;
}

/** No TTL on suppressions — they're explicit user choices and shouldn't
 *  silently re-surface. The user un-suppresses or the bucket is cleared. */
const SUPPRESS_PREFIX = 'audit:suppressed:';

/** Repo-scoped suppression key. Lowercased + trimmed for case stability;
 *  scoped per-user so two users can hold independent suppression sets
 *  on the same repo. */
export function suppressionKey(userId: string, owner: string, repo: string): string {
  return `${SUPPRESS_PREFIX}${userId}:${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

export async function getSuppressedIds(
  kv: KVNamespace | undefined,
  userId: string,
  owner: string,
  repo: string,
): Promise<ReadonlySet<string>> {
  if (!kv) return new Set();
  try {
    const data = (await kv.get(suppressionKey(userId, owner, repo), 'json')) as SuppressionList | null;
    return new Set(data?.ids ?? []);
  } catch {
    return new Set();
  }
}

/**
 * Add a finding-id to the per-repo suppression list. Returns the size of
 * the list after the write (1 means newly suppressed; unchanged size
 * means it was already there).
 */
export async function addSuppression(
  kv: KVNamespace | undefined,
  userId: string,
  owner: string,
  repo: string,
  findingId: string,
): Promise<{ added: boolean; total: number }> {
  if (!kv) return { added: false, total: 0 };
  const key = suppressionKey(userId, owner, repo);
  const before = (await kv.get(key, 'json')) as SuppressionList | null;
  const set = new Set(before?.ids ?? []);
  const wasAlreadyThere = set.has(findingId);
  set.add(findingId);
  const list: SuppressionList = {
    ids: [...set].sort(), // sorted so the JSON diffs cleanly run-over-run
    updatedAt: new Date().toISOString(),
  };
  await kv.put(key, JSON.stringify(list));
  return { added: !wasAlreadyThere, total: list.ids.length };
}

export async function removeSuppression(
  kv: KVNamespace | undefined,
  userId: string,
  owner: string,
  repo: string,
  findingId: string,
): Promise<{ removed: boolean; total: number }> {
  if (!kv) return { removed: false, total: 0 };
  const key = suppressionKey(userId, owner, repo);
  const before = (await kv.get(key, 'json')) as SuppressionList | null;
  if (!before) return { removed: false, total: 0 };
  const set = new Set(before.ids);
  const wasThere = set.delete(findingId);
  // Empty set → delete the key entirely so the listing doesn't accumulate
  // empty entries over time.
  if (set.size === 0) {
    await kv.delete(key);
    return { removed: wasThere, total: 0 };
  }
  const list: SuppressionList = {
    ids: [...set].sort(),
    updatedAt: new Date().toISOString(),
  };
  await kv.put(key, JSON.stringify(list));
  return { removed: wasThere, total: list.ids.length };
}
