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

/**
 * KV metadata attached to every persisted AuditRun. Lets the admin
 * tab sort keys by recency via `kv.list({...}).keys[].metadata`
 * without fetching every value. AuditRun itself carries no timestamp
 * field; rather than amending that schema we keep the timestamp
 * alongside the key so runs from older code (no metadata) still load
 * correctly — they just sort at the bottom of recency lists.
 */
export interface AuditRunMetadata {
  createdAtMs: number;
  owner: string;
  repo: string;
}

export async function cacheAuditRun(
  kv: KVNamespace | undefined,
  userId: string,
  run: AuditRun,
): Promise<void> {
  if (!kv) return;
  try {
    const meta: AuditRunMetadata = {
      createdAtMs: Date.now(),
      owner: run.repo.owner,
      repo: run.repo.name,
    };
    await kv.put(runCacheKey(userId, run.runId), JSON.stringify(run), {
      expirationTtl: RUN_TTL_SECONDS,
      metadata: meta,
    });
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

// ---------------------------------------------------------------------------
// Audit subscriptions (Phase 1, Slice A — scheduled audits)
// ---------------------------------------------------------------------------
//
// Storage layout:
//   audit:sub:{userId}:{owner}/{repo}  →  AuditSubscription JSON
//
// One key per (user, repo). No TTL — subscriptions are explicit user
// choices and shouldn't silently expire. The cron handler scans the
// `audit:sub:` prefix on each 6h tick, dispatches due audits via the
// existing TaskProcessor path, and updates `lastRunAt` / `lastRunId`
// (which references runs in the existing `audit:run:` storage — no
// parallel run schema).

const SUB_PREFIX = 'audit:sub:';

export interface AuditSubscription {
  userId: string;
  owner: string;
  repo: string;
  /** Where to deliver the report. Telegram-only for v1; the schema is
   *  stable enough to add other transports later by extending the union. */
  transport: 'telegram';
  chatId: number;
  /** Audit knobs — passed through to the dispatched run. */
  branch?: string;
  lens?: string; // single lens; undefined → all MVP lenses
  depth: 'quick' | 'standard' | 'deep';
  /** Cadence. Cron tick is 6h, so daily can drift up to ~6h late and
   *  weekly up to ~6h late — accepted trade-off vs adding a tighter cron. */
  interval: 'daily' | 'weekly';
  createdAt: string; // ISO
  lastRunAt: string | null; // ISO; null until first dispatch

  /**
   * The taskId of the most recent dispatch (== TaskProcessor task id). Set
   * on every successful dispatch — see src/cron/audit-subs.ts.
   *
   * Distinct from `lastRunId`: a `taskId` identifies a TaskProcessor run,
   * an `AuditRun.runId` identifies the persisted audit artefact. The
   * cron path knows the former at dispatch time; the latter is minted
   * inside the audit skill once Scout has resolved the SHA, and gets
   * written here later (Slice B) so /_admin/audit can fetch the
   * audit:run:{userId}:{runId} record directly.
   */
  lastTaskId: string | null;

  /**
   * The runId of the persisted AuditRun corresponding to lastTaskId, or
   * null until the audit skill writes back its completion. Slice B will
   * close that loop. Until then, the admin tab can still link a sub to
   * its dispatch via lastTaskId; lastRunId stays null.
   */
  lastRunId: string | null;

  /**
   * ISO timestamp set immediately *before* a dispatch goes out, cleared
   * after the lastRunAt/lastTaskId stamp lands. Used by the cron path to
   * skip a sub that another invocation is already dispatching — the
   * common case when a Worker scheduled handler is retried after a
   * network blip and both invocations scan the sub list.
   *
   * KV is not CAS, so this is BEST-EFFORT: two truly concurrent reads can
   * still both see `null` and dispatch. Strict once-only scheduling
   * would need a Durable Object keyed per subscription. For v1 the
   * window is small enough (cron ticks every 6h, scan + dispatch < 1s)
   * that the marker covers the realistic race.
   */
  dispatchStartedAt?: string;
}

/**
 * How long a `dispatchStartedAt` marker is honoured before being treated
 * as stale (i.e. the original dispatcher crashed before writing
 * lastRunAt). 10 minutes is comfortably longer than any plausible
 * accept-then-update sequence and short enough that a real crash
 * doesn't freeze the subscription forever.
 */
export const DISPATCH_IN_FLIGHT_GRACE_MS = 10 * 60 * 1000;

export function subscriptionKey(userId: string, owner: string, repo: string): string {
  return `${SUB_PREFIX}${userId}:${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

export async function setAuditSubscription(
  kv: KVNamespace | undefined,
  sub: AuditSubscription,
): Promise<boolean> {
  if (!kv) return false;
  try {
    await kv.put(subscriptionKey(sub.userId, sub.owner, sub.repo), JSON.stringify(sub));
    return true;
  } catch (err) {
    console.warn('[Audit] setAuditSubscription failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

export async function getAuditSubscription(
  kv: KVNamespace | undefined,
  userId: string,
  owner: string,
  repo: string,
): Promise<AuditSubscription | null> {
  if (!kv) return null;
  try {
    return (await kv.get(subscriptionKey(userId, owner, repo), 'json')) as AuditSubscription | null;
  } catch {
    return null;
  }
}

export async function deleteAuditSubscription(
  kv: KVNamespace | undefined,
  userId: string,
  owner: string,
  repo: string,
): Promise<boolean> {
  if (!kv) return false;
  const key = subscriptionKey(userId, owner, repo);
  try {
    const existing = await kv.get(key);
    if (existing === null) return false;
    await kv.delete(key);
    return true;
  } catch (err) {
    console.warn(
      '[Audit] deleteAuditSubscription failed:',
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/** List one user's subscriptions. Used by /audit subs. */
export async function listUserSubscriptions(
  kv: KVNamespace | undefined,
  userId: string,
): Promise<AuditSubscription[]> {
  if (!kv) return [];
  const prefix = `${SUB_PREFIX}${userId}:`;
  return readSubscriptions(kv, prefix);
}

/** List every subscription across all users. Used by the cron handler. */
export async function listAllSubscriptions(
  kv: KVNamespace | undefined,
): Promise<AuditSubscription[]> {
  if (!kv) return [];
  return readSubscriptions(kv, SUB_PREFIX);
}

async function readSubscriptions(kv: KVNamespace, prefix: string): Promise<AuditSubscription[]> {
  const out: AuditSubscription[] = [];
  let cursor: string | undefined;
  try {
    for (;;) {
      const page = await kv.list({ prefix, cursor });
      for (const k of page.keys) {
        try {
          const sub = (await kv.get(k.name, 'json')) as AuditSubscription | null;
          if (sub) out.push(sub);
        } catch (err) {
          // Skip malformed entries rather than aborting the scan; the
          // cron path needs to be robust to partial corruption.
          console.warn(
            `[Audit] readSubscriptions skip ${k.name}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
      if (page.list_complete) break;
      cursor = page.cursor;
      if (!cursor) break;
    }
  } catch (err) {
    console.warn(
      '[Audit] readSubscriptions list failed:',
      err instanceof Error ? err.message : err,
    );
  }
  return out;
}

/**
 * If a subscription exists for (userId, owner, repo), write the freshly
 * completed AuditRun's runId into its `lastRunId` field and clear any
 * lingering in-flight marker.
 *
 * Called at the end of every successful audit (whether dispatched by
 * cron or invoked manually) so the admin tab can link a subscription
 * to the persisted audit:run:{userId}:{runId} record. Returns true if a
 * sub was found and updated, false if none existed (the common case
 * for one-off /audit invocations on a non-tracked repo).
 *
 * Best-effort: KV failures log a warning but do not throw — the audit
 * itself has already succeeded and we don't want to fail the user-
 * visible result over admin-tab cosmetics.
 */
export async function linkRunToSubscription(
  kv: KVNamespace | undefined,
  userId: string,
  owner: string,
  repo: string,
  runId: string,
): Promise<boolean> {
  if (!kv) return false;
  try {
    const sub = await getAuditSubscription(kv, userId, owner, repo);
    if (!sub) return false;
    await setAuditSubscription(kv, {
      ...sub,
      lastRunId: runId,
      // Defensive: if the audit completed under an in-flight marker
      // that the cron path didn't manage to clear (rare — only happens
      // if setAuditSubscription failed at clear time), drop it now so
      // the next cron tick isn't blocked.
      dispatchStartedAt: undefined,
    });
    return true;
  } catch (err) {
    console.warn('[Audit] linkRunToSubscription failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Returns true if the subscription is due to run again at `nowMs`. */
export function isSubscriptionDue(sub: AuditSubscription, nowMs: number): boolean {
  // If a dispatch is in flight (within the grace window), skip — another
  // cron invocation is already handling this sub. See the comment on
  // AuditSubscription.dispatchStartedAt for the race-window discussion.
  if (sub.dispatchStartedAt) {
    const startedMs = Date.parse(sub.dispatchStartedAt);
    if (!Number.isNaN(startedMs) && nowMs - startedMs < DISPATCH_IN_FLIGHT_GRACE_MS) {
      return false;
    }
    // Stale marker (>= grace window): treat as a crashed dispatcher and
    // fall through to the cadence check.
  }
  if (!sub.lastRunAt) return true;
  const lastMs = Date.parse(sub.lastRunAt);
  if (Number.isNaN(lastMs)) return true; // corrupt timestamp → run anyway
  const intervalMs = sub.interval === 'daily' ? DAY_MS : 7 * DAY_MS;
  return nowMs - lastMs >= intervalMs;
}

// ---------------------------------------------------------------------------
// Admin tab support — read-only aggregators across users
// ---------------------------------------------------------------------------
//
// The admin tab is operator-scoped (CF Access protected) so it sees every
// user's data. These helpers do prefix scans over the existing namespaces
// — no new storage shape, no parallel index. Reuse over invent.

/** One row in the admin tab's "Recent runs" table. */
export interface AuditRunSummary {
  userId: string;
  runId: string;
  owner: string;
  repo: string;
  sha: string;
  lenses: string[];
  depth: string;
  findings: number;
  costUsd: number;
  llmCalls: number;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  createdAtMs: number | null; // null for runs persisted before metadata was added
}

/** One row in the admin tab's "Suppressed findings" table. */
export interface SuppressionEntry {
  userId: string;
  owner: string;
  repo: string;
  findingId: string;
  at: string | null;
}

/**
 * List the most-recent N AuditRuns across all users.
 *
 * Uses the metadata written by cacheAuditRun() to sort by recency
 * without fetching every value, then materializes the top `limit` rows.
 * Older runs (pre-metadata) get `createdAtMs = null` and sort to the
 * end — they remain visible but lose their relative ordering.
 */
export async function listRecentRuns(
  kv: KVNamespace | undefined,
  limit = 20,
): Promise<AuditRunSummary[]> {
  if (!kv) return [];

  const candidates: { name: string; meta: AuditRunMetadata | null }[] = [];
  let cursor: string | undefined;
  // Bound the scan: at most ~5 pages × KV's default page size keeps the
  // worst-case latency predictable. Runs have a 7-day TTL so the live
  // keyspace stays small in practice.
  const MAX_PAGES = 5;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await kv.list<AuditRunMetadata>({ prefix: RUN_PREFIX, cursor });
      for (const k of res.keys) {
        candidates.push({ name: k.name, meta: k.metadata ?? null });
      }
      if (res.list_complete) break;
      cursor = res.cursor;
      if (!cursor) break;
    }
  } catch (err) {
    console.warn('[Audit] listRecentRuns scan failed:', err instanceof Error ? err.message : err);
    return [];
  }

  // Sort: keys with metadata first (most-recent → oldest), then unstamped
  // ones in arbitrary list order at the end.
  candidates.sort((a, b) => {
    const am = a.meta?.createdAtMs ?? -Infinity;
    const bm = b.meta?.createdAtMs ?? -Infinity;
    return bm - am;
  });

  const rows: AuditRunSummary[] = [];
  for (const c of candidates.slice(0, limit)) {
    // Key shape: audit:run:{userId}:{runId}
    const tail = c.name.slice(RUN_PREFIX.length);
    const sep = tail.indexOf(':');
    if (sep < 0) continue;
    const userId = tail.slice(0, sep);
    const runId = tail.slice(sep + 1);
    let run: AuditRun | null = null;
    try {
      run = (await kv.get(c.name, 'json')) as AuditRun | null;
    } catch {
      // Skip on read failure rather than aborting the whole list.
      continue;
    }
    if (!run) continue;
    rows.push({
      userId,
      runId,
      owner: run.repo.owner,
      repo: run.repo.name,
      sha: run.repo.sha,
      lenses: [...run.lenses],
      depth: run.depth,
      findings: run.findings.length,
      costUsd: run.telemetry.costUsd,
      llmCalls: run.telemetry.llmCalls,
      tokensIn: run.telemetry.tokensIn,
      tokensOut: run.telemetry.tokensOut,
      durationMs: run.telemetry.durationMs,
      createdAtMs: c.meta?.createdAtMs ?? null,
    });
  }
  return rows;
}

/**
 * List every suppression entry across all users. Each KV key carries a
 * tiny JSON value `{at: ISO}`; we fetch it for the timestamp and parse
 * the (userId, owner, repo, findingId) triple from the key itself.
 */
export async function listAllSuppressions(
  kv: KVNamespace | undefined,
): Promise<SuppressionEntry[]> {
  if (!kv) return [];
  const out: SuppressionEntry[] = [];
  let cursor: string | undefined;
  const MAX_PAGES = 5;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await kv.list({ prefix: SUPPRESS_PREFIX, cursor });
      for (const k of res.keys) {
        // Key shape: audit:suppressed:{userId}:{owner}/{repo}:{findingId}
        const tail = k.name.slice(SUPPRESS_PREFIX.length);
        const sepUser = tail.indexOf(':');
        if (sepUser < 0) continue;
        const userId = tail.slice(0, sepUser);
        const afterUser = tail.slice(sepUser + 1);
        const sepRepo = afterUser.indexOf(':');
        if (sepRepo < 0) continue;
        const repoSlug = afterUser.slice(0, sepRepo);
        const findingId = afterUser.slice(sepRepo + 1);
        const slash = repoSlug.indexOf('/');
        if (slash < 0) continue;
        const owner = repoSlug.slice(0, slash);
        const repo = repoSlug.slice(slash + 1);

        let at: string | null = null;
        try {
          const v = (await kv.get(k.name, 'json')) as { at?: string } | null;
          at = v?.at ?? null;
        } catch {
          // Best-effort: an unreadable suppression entry should not stop
          // the rest of the listing. Surface what we can.
        }
        out.push({ userId, owner, repo, findingId, at });
      }
      if (res.list_complete) break;
      cursor = res.cursor;
      if (!cursor) break;
    }
  } catch (err) {
    console.warn(
      '[Audit] listAllSuppressions scan failed:',
      err instanceof Error ? err.message : err,
    );
  }
  return out;
}

/**
 * Aggregated payload the /_admin/audit tab fetches in one round-trip.
 * Each section reuses the canonical KV namespace for its data type;
 * the admin tab does not introduce a parallel storage convention.
 */
export interface AuditOverview {
  subscriptions: AuditSubscription[];
  recentRuns: AuditRunSummary[];
  suppressions: SuppressionEntry[];
}

export async function getAuditOverview(
  kv: KVNamespace | undefined,
  options: { runLimit?: number } = {},
): Promise<AuditOverview> {
  if (!kv) {
    return { subscriptions: [], recentRuns: [], suppressions: [] };
  }
  const [subscriptions, recentRuns, suppressions] = await Promise.all([
    listAllSubscriptions(kv),
    listRecentRuns(kv, options.runLimit ?? 20),
    listAllSuppressions(kv),
  ]);
  return { subscriptions, recentRuns, suppressions };
}
