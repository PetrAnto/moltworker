import { describe, it, expect, vi } from 'vitest';
import {
  setAuditSubscription,
  getAuditSubscription,
  deleteAuditSubscription,
  listUserSubscriptions,
  listAllSubscriptions,
  subscriptionKey,
  isSubscriptionDue,
  type AuditSubscription,
} from './cache';

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
 */
function makeKV() {
  const store = new Map<string, string>();
  const kv = {
    get: vi.fn(async (key: string, type?: string) => {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async (opts: { prefix?: string; cursor?: string }) => {
      const prefix = opts.prefix ?? '';
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true, cursor: undefined as string | undefined };
    }),
  } as unknown as KVNamespace;
  return { kv, store };
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
    const fresh = new Date(now - 60 * 1000).toISOString(); // 1 min ago
    // Even with no lastRunAt set, the in-flight marker prevents another
    // cron invocation from re-dispatching.
    expect(isSubscriptionDue(makeSub({ dispatchStartedAt: fresh }), now)).toBe(false);
  });

  it('ignores a stale in-flight marker (treated as crashed dispatcher)', () => {
    // 11 minutes ago — past the 10-min grace window in cache.ts.
    const stale = new Date(now - 11 * 60 * 1000).toISOString();
    expect(isSubscriptionDue(makeSub({ dispatchStartedAt: stale, lastRunAt: null }), now)).toBe(
      true,
    );
  });
});
