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
// Suppression list (per-user-per-repo, one KV key per finding)
// ---------------------------------------------------------------------------
//
// Storage layout:
//   audit:suppressed:{userId}:{owner}/{repo}:{findingId}
// with a tiny JSON metadata payload `{ at: ISO }`.
//
// One-key-per-finding eliminates the read-modify-write race that a
// single aggregated list would have under concurrent suppress clicks
// (T1 and T2 both read [], T1 writes [a], T2 overwrites with [b],
// finding `a` lost). Each suppress is now an unconditional `put`; each
// unsuppress an unconditional `delete`. Filtering uses `kv.list()` over
// the per-repo prefix.
//
// No TTL on suppressions — they're explicit user choices and shouldn't
// silently re-surface.

const SUPPRESS_PREFIX = 'audit:suppressed:';

/** Per-repo prefix — used by getSuppressedIds() to list one user's
 *  suppressions for one repo. */
function suppressionRepoPrefix(userId: string, owner: string, repo: string): string {
  return `${SUPPRESS_PREFIX}${userId}:${owner.toLowerCase()}/${repo.toLowerCase()}:`;
}

/** Per-finding key. Lowercased owner/repo for case stability. */
export function suppressionKey(
  userId: string,
  owner: string,
  repo: string,
  findingId: string,
): string {
  return `${suppressionRepoPrefix(userId, owner, repo)}${findingId}`;
}

export async function getSuppressedIds(
  kv: KVNamespace | undefined,
  userId: string,
  owner: string,
  repo: string,
): Promise<ReadonlySet<string>> {
  if (!kv) return new Set();
  try {
    const prefix = suppressionRepoPrefix(userId, owner, repo);
    const ids = new Set<string>();
    // KV list pages at 1000 keys; in practice no repo gets >100 suppressions
    // for one user. Walk pages anyway so the contract is correct under
    // pathological load.
    let cursor: string | undefined;
    for (;;) {
      const page = await kv.list({ prefix, cursor });
      for (const k of page.keys) {
        const id = k.name.slice(prefix.length);
        if (id) ids.add(id);
      }
      if (page.list_complete) break;
      cursor = page.cursor;
      if (!cursor) break;
    }
    return ids;
  } catch {
    return new Set();
  }
}

/**
 * Suppress a finding-id. Idempotent: re-suppressing the same id is a no-op
 * write. Returns whether the id was newly added (the caller surfaces
 * "already on list" vs "newly suppressed" UX); `total` is the post-write
 * size of the per-repo set.
 */
export async function addSuppression(
  kv: KVNamespace | undefined,
  userId: string,
  owner: string,
  repo: string,
  findingId: string,
): Promise<{ added: boolean; total: number }> {
  if (!kv) return { added: false, total: 0 };
  const key = suppressionKey(userId, owner, repo, findingId);
  // Single get to detect "already there" for the UX message — not used for
  // mutation logic, so it's not in the RMW critical path.
  const existing = await kv.get(key);
  await kv.put(key, JSON.stringify({ at: new Date().toISOString() }));
  const total = (await getSuppressedIds(kv, userId, owner, repo)).size;
  return { added: existing === null, total };
}

export async function removeSuppression(
  kv: KVNamespace | undefined,
  userId: string,
  owner: string,
  repo: string,
  findingId: string,
): Promise<{ removed: boolean; total: number }> {
  if (!kv) return { removed: false, total: 0 };
  const key = suppressionKey(userId, owner, repo, findingId);
  const existing = await kv.get(key);
  if (existing !== null) {
    await kv.delete(key);
  }
  const total = (await getSuppressedIds(kv, userId, owner, repo)).size;
  return { removed: existing !== null, total };
}
