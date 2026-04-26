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

/**
 * Result of reading the per-repo suppression set.
 *
 * `error` is non-null when the underlying KV read failed (network, quota,
 * malformed list response, etc.) so the caller can surface a clear
 * warning to the user. The earlier `Promise<Set>` shape silently
 * returned an empty set on failure, which made previously-suppressed
 * findings re-surface without any signal that the suppression list
 * could not be read. Closes GPT slice-4c review (PR 511) follow-up.
 */
export interface SuppressionReadResult {
  ids: ReadonlySet<string>;
  error: string | null;
}

export async function getSuppressedIds(
  kv: KVNamespace | undefined,
  userId: string,
  owner: string,
  repo: string,
): Promise<SuppressionReadResult> {
  if (!kv) return { ids: new Set(), error: null };
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
    return { ids, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Audit] suppression list read failed for ${userId}@${owner}/${repo}: ${msg}`);
    return { ids: new Set(), error: msg };
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
  const total = (await getSuppressedIds(kv, userId, owner, repo)).ids.size;
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
  const total = (await getSuppressedIds(kv, userId, owner, repo)).ids.size;
  return { removed: existing !== null, total };
}

// ---------------------------------------------------------------------------
// Fix dispatch drafts (audit:fixdraft:{userId}:{token})
// ---------------------------------------------------------------------------
//
// Closes GPT slice-4d follow-up findings 1 + 2: stores the prepared
// orchestra task text behind a short-lived token so:
//
//   1. Confirm dispatches EXACTLY the taskText the user reviewed in the
//      Prepare summary (no re-resolution that could differ if the run
//      was deleted/replaced between the two clicks).
//   2. Confirm consumes the draft (delete-first), so a second confirm
//      tap finds null and reports "already dispatched / expired" instead
//      of starting a duplicate orchestra run. KV is eventually
//      consistent so this is best-effort, not a hard CAS lock — pairs
//      with the keyboard-removal already in place.
//
// Side benefit: callback_data shrinks from
//   audit:go:<36-char-uuid>:<finding-id>  (~63 bytes worst case)
// to
//   audit:go:<16-char-token>              (~24 bytes)
// freeing headroom for longer finding-ids if the validator schema grows.

const FIX_DRAFT_PREFIX = 'audit:fixdraft:';
/** TTL for prepared fixes. Long enough for a "let me check the
 *  preventive artifact in slack first" pause; short enough that
 *  abandoned drafts don't accumulate in KV. */
const FIX_DRAFT_TTL_SECONDS = 30 * 60;

export interface FixDraft {
  runId: string;
  findingId: string;
  /** The exact orchestra task text the user reviewed in the Prepare
   *  summary. On Confirm, dispatched verbatim — no re-resolution. */
  taskText: string;
  /** Repo coords + finding metadata cached so the Confirm ack one-liner
   *  doesn't need a second KV round-trip to the run. */
  owner: string;
  repo: string;
  severity: string;
  lens: string;
  createdAt: string;
}

function fixDraftKey(userId: string, token: string): string {
  return `${FIX_DRAFT_PREFIX}${userId}:${token}`;
}

/**
 * Generate a fresh 16-hex-char token (64 random bits). Per-user
 * keyspace + 30-min TTL keeps collision risk effectively zero.
 */
export function newFixDraftToken(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

/**
 * Persist a fix draft. Returns `true` if the put succeeded, `false`
 * otherwise (KV unavailable, write failed). Callers MUST gate the
 * Confirm button on this — without it, a failed put produces a usable-
 * looking ✅ Dispatch button whose first tap reports "expired or
 * already processed". Closes GPT slice-4d (PR 514) follow-up #1.
 */
export async function cacheFixDraft(
  kv: KVNamespace | undefined,
  userId: string,
  token: string,
  draft: FixDraft,
): Promise<boolean> {
  if (!kv) return false;
  try {
    await kv.put(fixDraftKey(userId, token), JSON.stringify(draft), {
      expirationTtl: FIX_DRAFT_TTL_SECONDS,
    });
    return true;
  } catch (err) {
    console.warn('[Audit] cacheFixDraft failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Read + delete in sequence (best-effort consume). Returns the draft
 * for the caller to dispatch, or null if not found / already consumed.
 *
 * KV is eventually consistent so two near-simultaneous confirms can
 * both read the draft; the keyboard-removal in the handler covers the
 * common UI-double-tap case, this covers the "Telegram retried our
 * callback / network blip" case once the first delete propagates.
 */
export async function consumeFixDraft(
  kv: KVNamespace | undefined,
  userId: string,
  token: string,
): Promise<FixDraft | null> {
  if (!kv) return null;
  try {
    const key = fixDraftKey(userId, token);
    const draft = (await kv.get(key, 'json')) as FixDraft | null;
    if (draft) {
      // Delete eagerly so subsequent confirm reads see null.
      await kv.delete(key);
    }
    return draft;
  } catch (err) {
    console.warn('[Audit] consumeFixDraft failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Cancel path — idempotent. */
export async function deleteFixDraft(
  kv: KVNamespace | undefined,
  userId: string,
  token: string,
): Promise<void> {
  if (!kv) return;
  try {
    await kv.delete(fixDraftKey(userId, token));
  } catch {
    // best-effort — TTL reaps if delete failed
  }
}
