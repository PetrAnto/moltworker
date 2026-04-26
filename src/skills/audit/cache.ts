/**
 * Audit Skill — Profile Cache (NEXUS_KV)
 *
 * Caches `RepoProfile` by (owner, repo, sha). Same SHA → identical Scout
 * output, so this is a perfect content-addressed cache. TTL is generous
 * (24h) since the SHA itself is the cache-busting signal.
 */

import type { RepoProfile } from './types';

const CACHE_TTL_SECONDS = 24 * 60 * 60;
const CACHE_PREFIX = 'audit:profile:';

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
