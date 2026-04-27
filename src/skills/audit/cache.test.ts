import { describe, it, expect, vi } from 'vitest';
import {
  setAuditSubscription,
  getAuditSubscription,
  deleteAuditSubscription,
  listUserSubscriptions,
  listAllSubscriptions,
  subscriptionKey,
  isSubscriptionDue,
  linkRunToSubscription,
  cacheAuditRun,
  listRecentRuns,
  listAllSuppressions,
  getAuditOverview,
  addSuppression,
  DISPATCH_IN_FLIGHT_GRACE_MS,
  type AuditSubscription,
  type AuditRunMetadata,
} from './cache';
import type { AuditRun } from './types';

function makeSub(overrides: Partial<AuditSubscription> = {}): AuditSubscription {
  return {
    userId: 'user-1',
    owner: 'octocat',
    repo: 'demo',
    transport: 'telegram',
    chatId: 1234,
    depth: 'quick',
    interval: 'weekly',
    createdAt: new Date('2026-04-01T00:00:00Z').toISOString(),
    lastRunAt: null,
    lastTaskId: null,
    lastRunId: null,
    ...overrides,
  };
}

/**
 * In-memory KV stand-in. The real Workers KV is eventually consistent
 * across regions, but per-instance reads-after-writes are immediate,
 * which is the only behavior the cache layer relies on.
 *
 * Tracks per-key metadata so listRecentRuns() can sort by createdAtMs
 * without inventing a separate index.
 */
function makeKV() {
  const store = new Map<string, string>();
  const metaStore = new Map<string, unknown>();
  const kv = {
    get: vi.fn(async (key: string, type?: string) => {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    }),
    put: vi.fn(async (key: string, value: string, opts?: { metadata?: unknown }) => {
      store.set(key, value);
      if (opts?.metadata !== undefined) {
        metaStore.set(key, opts.metadata);
      }
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
      metaStore.delete(key);
    }),
    list: vi.fn(async (opts: { prefix?: string; cursor?: string }) => {
      const prefix = opts.prefix ?? '';
      const keys = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((name) => ({ name, metadata: metaStore.get(name) }));
      return { keys, list_complete: true, cursor: undefined as string | undefined };
    }),
  } as unknown as KVNamespace;
  return { kv, store, metaStore };
}

describe('subscriptionKey', () => {
  it('lowercases owner and repo for stability', () => {
    expect(subscriptionKey('u1', 'OctoCat', 'Hello-World')).toBe(
      'audit:sub:u1:octocat/hello-world',
    );
  });

  it('keeps userId case-sensitive (telegram ids are numeric strings)', () => {
    expect(subscriptionKey('User-42', 'a', 'b')).toBe('audit:sub:User-42:a/b');
  });
});

describe('setAuditSubscription / getAuditSubscription / deleteAuditSubscription', () => {
  it('round-trips a subscription', async () => {
    const { kv } = makeKV();
    const sub = makeSub();
    expect(await setAuditSubscription(kv, sub)).toBe(true);
    const read = await getAuditSubscription(kv, sub.userId, sub.owner, sub.repo);
    expect(read).toEqual(sub);
  });

  it('returns null for missing subscription', async () => {
    const { kv } = makeKV();
    expect(await getAuditSubscription(kv, 'u', 'o', 'r')).toBeNull();
  });

  it('delete returns false when nothing exists', async () => {
    const { kv } = makeKV();
    expect(await deleteAuditSubscription(kv, 'u', 'o', 'r')).toBe(false);
  });

  it('delete returns true when an entry was removed', async () => {
    const { kv } = makeKV();
    await setAuditSubscription(kv, makeSub());
    expect(await deleteAuditSubscription(kv, 'user-1', 'octocat', 'demo')).toBe(true);
    expect(await getAuditSubscription(kv, 'user-1', 'octocat', 'demo')).toBeNull();
  });

  it('owner/repo lookup is case-insensitive (matches subscriptionKey lowercasing)', async () => {
    const { kv } = makeKV();
    await setAuditSubscription(kv, makeSub({ owner: 'OctoCat', repo: 'Demo' }));
    expect(await getAuditSubscription(kv, 'user-1', 'octocat', 'demo')).not.toBeNull();
    expect(await getAuditSubscription(kv, 'user-1', 'OCTOCAT', 'DEMO')).not.toBeNull();
  });

  it('returns false on KV unavailability rather than throwing', async () => {
    expect(await setAuditSubscription(undefined, makeSub())).toBe(false);
    expect(await getAuditSubscription(undefined, 'u', 'o', 'r')).toBeNull();
    expect(await deleteAuditSubscription(undefined, 'u', 'o', 'r')).toBe(false);
  });
});

describe('listUserSubscriptions', () => {
  it('returns only the requesting user’s subscriptions', async () => {
    const { kv } = makeKV();
    await setAuditSubscription(kv, makeSub({ userId: 'a', owner: 'o1', repo: 'r1' }));
    await setAuditSubscription(kv, makeSub({ userId: 'a', owner: 'o2', repo: 'r2' }));
    await setAuditSubscription(kv, makeSub({ userId: 'b', owner: 'o3', repo: 'r3' }));

    const subs = await listUserSubscriptions(kv, 'a');
    expect(subs).toHaveLength(2);
    expect(subs.map((s) => `${s.owner}/${s.repo}`).sort()).toEqual(['o1/r1', 'o2/r2']);
  });

  it('returns empty array when KV is missing', async () => {
    expect(await listUserSubscriptions(undefined, 'a')).toEqual([]);
  });
});

describe('listAllSubscriptions', () => {
  it('returns subscriptions across users (cron path)', async () => {
    const { kv } = makeKV();
    await setAuditSubscription(kv, makeSub({ userId: 'a', owner: 'o1', repo: 'r1' }));
    await setAuditSubscription(kv, makeSub({ userId: 'b', owner: 'o2', repo: 'r2' }));
    const subs = await listAllSubscriptions(kv);
    expect(subs).toHaveLength(2);
    expect(new Set(subs.map((s) => s.userId))).toEqual(new Set(['a', 'b']));
  });

  it('skips malformed entries rather than aborting', async () => {
    const { kv, store } = makeKV();
    await setAuditSubscription(kv, makeSub({ userId: 'a', owner: 'o1', repo: 'r1' }));
    store.set('audit:sub:b:o2/r2', '{not valid json');
    const subs = await listAllSubscriptions(kv);
    // The good one survives even though the corrupt entry made `kv.get` throw.
    expect(subs).toHaveLength(1);
    expect(subs[0].owner).toBe('o1');
  });
});

describe('isSubscriptionDue', () => {
  const now = Date.parse('2026-04-15T12:00:00Z');

  it('first-time runs are always due', () => {
    expect(isSubscriptionDue(makeSub({ lastRunAt: null }), now)).toBe(true);
  });

  it('weekly is not due before 7 days', () => {
    const lastRunAt = new Date(now - 6 * 24 * 60 * 60 * 1000).toISOString();
    expect(isSubscriptionDue(makeSub({ interval: 'weekly', lastRunAt }), now)).toBe(false);
  });

  it('weekly is due at 7 days exactly', () => {
    const lastRunAt = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    expect(isSubscriptionDue(makeSub({ interval: 'weekly', lastRunAt }), now)).toBe(true);
  });

  it('daily is due at 24 hours', () => {
    const lastRunAt = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    expect(isSubscriptionDue(makeSub({ interval: 'daily', lastRunAt }), now)).toBe(true);
  });

  it('daily is not due at 23 hours', () => {
    const lastRunAt = new Date(now - 23 * 60 * 60 * 1000).toISOString();
    expect(isSubscriptionDue(makeSub({ interval: 'daily', lastRunAt }), now)).toBe(false);
  });

  it('treats malformed lastRunAt as "due now" so a corrupt write doesn’t freeze a sub', () => {
    expect(isSubscriptionDue(makeSub({ lastRunAt: 'not a date' }), now)).toBe(true);
  });

  it('treats a fresh in-flight marker as not-due (cron skips it)', () => {
    // Just inside the grace window — a parallel cron tick is still dispatching.
    const fresh = new Date(now - (DISPATCH_IN_FLIGHT_GRACE_MS - 1000)).toISOString();
    expect(isSubscriptionDue(makeSub({ dispatchStartedAt: fresh }), now)).toBe(false);
  });

  it('ignores a stale in-flight marker (treated as crashed dispatcher)', () => {
    // Just outside the grace window — original dispatcher is presumed dead.
    const stale = new Date(now - (DISPATCH_IN_FLIGHT_GRACE_MS + 1000)).toISOString();
    expect(isSubscriptionDue(makeSub({ dispatchStartedAt: stale, lastRunAt: null }), now)).toBe(
      true,
    );
  });

  it('treats marker exactly at the grace boundary as stale (>= comparison)', () => {
    const atBoundary = new Date(now - DISPATCH_IN_FLIGHT_GRACE_MS).toISOString();
    expect(
      isSubscriptionDue(makeSub({ dispatchStartedAt: atBoundary, lastRunAt: null }), now),
    ).toBe(true);
  });
});

describe('linkRunToSubscription', () => {
  it('writes runId into an existing subscription', async () => {
    const { kv, store } = makeKV();
    await setAuditSubscription(kv, makeSub({ owner: 'octocat', repo: 'demo' }));
    const updated = await linkRunToSubscription(
      kv,
      'user-1',
      'octocat',
      'demo',
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    );
    expect(updated).toBe(true);
    const stored = JSON.parse(store.get('audit:sub:user-1:octocat/demo')!) as AuditSubscription;
    expect(stored.lastRunId).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  });

  it('returns false (no-op) when no subscription exists for the repo', async () => {
    const { kv } = makeKV();
    const updated = await linkRunToSubscription(kv, 'user-1', 'unknown', 'repo', 'rid');
    expect(updated).toBe(false);
  });

  it('clears a lingering dispatchStartedAt marker so a stuck sub recovers', async () => {
    const { kv, store } = makeKV();
    const fresh = new Date().toISOString();
    await setAuditSubscription(kv, makeSub({ dispatchStartedAt: fresh }));
    await linkRunToSubscription(kv, 'user-1', 'octocat', 'demo', 'rid');
    const stored = JSON.parse(store.get('audit:sub:user-1:octocat/demo')!) as AuditSubscription;
    expect(stored.dispatchStartedAt).toBeUndefined();
  });

  it('returns false when KV is missing rather than throwing', async () => {
    expect(await linkRunToSubscription(undefined, 'u', 'o', 'r', 'rid')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Admin-tab aggregators (listRecentRuns / listAllSuppressions / getAuditOverview)
// ---------------------------------------------------------------------------

function makeRun(overrides: Partial<AuditRun> = {}): AuditRun {
  return {
    runId: '00000000-0000-4000-8000-000000000000',
    repo: { owner: 'octocat', name: 'demo', sha: 'a'.repeat(40) },
    lenses: ['security'],
    depth: 'quick',
    findings: [],
    telemetry: {
      durationMs: 1500,
      llmCalls: 2,
      tokensIn: 1000,
      tokensOut: 500,
      costUsd: 0.05,
      githubApiCalls: 4,
    },
    ...overrides,
  };
}

describe('cacheAuditRun', () => {
  it('returns true and writes createdAtMs + repo metadata on success', async () => {
    const { kv, metaStore } = makeKV();
    const run = makeRun({ runId: 'r1' });
    const ok = await cacheAuditRun(kv, 'u1', run);
    expect(ok).toBe(true);
    const meta = metaStore.get('audit:run:u1:r1') as AuditRunMetadata | undefined;
    expect(meta).toBeDefined();
    expect(meta!.owner).toBe('octocat');
    expect(meta!.repo).toBe('demo');
    expect(typeof meta!.createdAtMs).toBe('number');
  });

  it('returns false when KV is missing (no throw)', async () => {
    const ok = await cacheAuditRun(undefined, 'u1', makeRun());
    expect(ok).toBe(false);
  });

  it('returns false when the underlying put throws', async () => {
    // GPT review #1: callers gate writeback on this — a put failure
    // must not leave a subscription pointing at a runId that nothing
    // can resolve.
    const kv = {
      put: vi.fn(async () => {
        throw new Error('kv unavailable');
      }),
    } as unknown as KVNamespace;
    const ok = await cacheAuditRun(kv, 'u1', makeRun());
    expect(ok).toBe(false);
  });
});

describe('listRecentRuns', () => {
  it('returns rows sorted by createdAtMs descending', async () => {
    const { kv } = makeKV();
    // Persist three runs with monotonically increasing timestamps.
    let now = Date.parse('2026-04-01T00:00:00Z');
    const original = Date.now;
    Date.now = () => now;
    try {
      await cacheAuditRun(kv, 'u1', makeRun({ runId: 'r-old' }));
      now += 60_000;
      await cacheAuditRun(kv, 'u1', makeRun({ runId: 'r-mid' }));
      now += 60_000;
      await cacheAuditRun(kv, 'u1', makeRun({ runId: 'r-new' }));
    } finally {
      Date.now = original;
    }

    const rows = await listRecentRuns(kv, 10);
    expect(rows.map((r) => r.runId)).toEqual(['r-new', 'r-mid', 'r-old']);
    expect(rows[0].userId).toBe('u1');
    expect(rows[0].owner).toBe('octocat');
    expect(rows[0].repo).toBe('demo');
    expect(rows[0].costUsd).toBe(0.05);
  });

  it('respects the limit parameter', async () => {
    const { kv } = makeKV();
    for (let i = 0; i < 5; i++) {
      await cacheAuditRun(kv, 'u1', makeRun({ runId: `r-${i}` }));
    }
    const rows = await listRecentRuns(kv, 2);
    expect(rows).toHaveLength(2);
  });

  it('places rows without metadata at the end (back-compat with older runs)', async () => {
    const { kv, store } = makeKV();
    // Pre-existing run written by older code path: no metadata.
    store.set('audit:run:u1:r-legacy', JSON.stringify(makeRun({ runId: 'r-legacy' })));
    await cacheAuditRun(kv, 'u1', makeRun({ runId: 'r-new' }));
    const rows = await listRecentRuns(kv, 10);
    expect(rows[0].runId).toBe('r-new');
    expect(rows.find((r) => r.runId === 'r-legacy')).toBeDefined();
  });

  it('returns empty array when KV is missing', async () => {
    expect(await listRecentRuns(undefined, 10)).toEqual([]);
  });
});

describe('listAllSuppressions', () => {
  it('returns a row per suppression with userId/owner/repo/findingId parsed from the key', async () => {
    const { kv } = makeKV();
    await addSuppression(kv, 'u1', 'octocat', 'demo', 'security-abc');
    await addSuppression(kv, 'u2', 'foo', 'bar', 'types-xyz');

    const rows = await listAllSuppressions(kv);
    expect(rows).toHaveLength(2);
    const u1 = rows.find((r) => r.userId === 'u1')!;
    expect(u1.owner).toBe('octocat');
    expect(u1.repo).toBe('demo');
    expect(u1.findingId).toBe('security-abc');
    expect(u1.at).not.toBeNull();
  });

  it('returns empty array when KV is missing', async () => {
    expect(await listAllSuppressions(undefined)).toEqual([]);
  });
});

describe('getAuditOverview', () => {
  it('aggregates subscriptions, recent runs, and suppressions in one call', async () => {
    const { kv } = makeKV();
    await setAuditSubscription(kv, makeSub({ userId: 'u1', owner: 'a', repo: 'a' }));
    await cacheAuditRun(kv, 'u1', makeRun({ runId: 'r1' }));
    await addSuppression(kv, 'u1', 'a', 'a', 'security-abc');

    const ov = await getAuditOverview(kv);
    expect(ov.subscriptions).toHaveLength(1);
    expect(ov.recentRuns).toHaveLength(1);
    expect(ov.suppressions).toHaveLength(1);
  });

  it('returns empty sections when KV is missing rather than throwing', async () => {
    const ov = await getAuditOverview(undefined);
    expect(ov).toEqual({ subscriptions: [], recentRuns: [], suppressions: [] });
  });
});
