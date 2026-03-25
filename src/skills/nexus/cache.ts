/**
 * Nexus — KV-based Research Cache
 *
 * Caches dossiers in Cloudflare KV with a 4-hour TTL.
 * Normalized cache keys ensure consistent hits for equivalent queries.
 */

import type { NexusDossier } from './types';

/** Cache TTL in seconds (4 hours). */
const CACHE_TTL_SECONDS = 4 * 60 * 60;

/** Prefix for all Nexus cache keys. */
const CACHE_PREFIX = 'nexus:';

/**
 * Normalize a query into a stable cache key.
 * Lowercases, trims, collapses whitespace, strips punctuation.
 */
export function normalizeCacheKey(query: string, mode: string): string {
  const normalized = query
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, '-');
  return `${CACHE_PREFIX}${mode}:${normalized}`;
}

/**
 * Get a cached dossier from KV.
 * Returns null on miss or if KV is not configured.
 */
export async function getCachedDossier(
  kv: KVNamespace | undefined,
  query: string,
  mode: string,
): Promise<NexusDossier | null> {
  if (!kv) return null;
  const key = normalizeCacheKey(query, mode);
  try {
    const data = await kv.get(key, 'json');
    return data as NexusDossier | null;
  } catch {
    return null;
  }
}

/**
 * Cache a dossier in KV with TTL.
 * No-op if KV is not configured.
 */
export async function cacheDossier(
  kv: KVNamespace | undefined,
  dossier: NexusDossier,
): Promise<void> {
  if (!kv) return;
  const key = normalizeCacheKey(dossier.query, dossier.mode);
  try {
    await kv.put(key, JSON.stringify(dossier), { expirationTtl: CACHE_TTL_SECONDS });
  } catch (err) {
    console.error('[NexusCache] Failed to cache dossier:', err instanceof Error ? err.message : err);
  }
}
