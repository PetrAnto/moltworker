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
