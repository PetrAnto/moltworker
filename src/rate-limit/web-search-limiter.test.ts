import { describe, it, expect, beforeEach } from 'vitest';
import {
  createWebSearchLimiter,
  parseWebSearchLimiterConfig,
  dayKey,
  type WebSearchLimiterConfig,
} from './web-search-limiter';

// Minimal in-memory R2 mock that satisfies the Pick<R2Bucket, 'get' | 'put'> contract.
function createMockR2() {
  const store = new Map<string, string>();
  return {
    store,
    get: async (key: string) => {
      const value = store.get(key);
      if (value === undefined) return null;
      return {
        text: async () => value,
      } as unknown as R2ObjectBody;
    },
    put: async (key: string, value: string) => {
      store.set(key, value);
      return {} as R2Object;
    },
  };
}

const defaultConfig: WebSearchLimiterConfig = {
  userDailyLimit: 20,
  taskLimit: 5,
  globalDailyLimit: 200,
  allowlistUsers: new Set(),
};

function fixedNow(iso: string): () => Date {
  return () => new Date(iso);
}

describe('dayKey', () => {
  it('returns YYYY-MM-DD in UTC', () => {
    expect(dayKey(new Date('2026-04-08T07:30:00Z'))).toBe('2026-04-08');
  });

  it('handles year boundaries', () => {
    expect(dayKey(new Date('2025-12-31T23:59:59Z'))).toBe('2025-12-31');
    expect(dayKey(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01');
  });
});

describe('parseWebSearchLimiterConfig', () => {
  it('uses defaults when env vars are missing', () => {
    const config = parseWebSearchLimiterConfig({});
    expect(config.userDailyLimit).toBe(20);
    expect(config.taskLimit).toBe(5);
    expect(config.globalDailyLimit).toBe(200);
    expect(config.allowlistUsers.size).toBe(0);
  });

  it('parses valid numeric env vars', () => {
    const config = parseWebSearchLimiterConfig({
      WEB_SEARCH_USER_DAILY_LIMIT: '50',
      WEB_SEARCH_TASK_LIMIT: '10',
      WEB_SEARCH_GLOBAL_DAILY_LIMIT: '1000',
    });
    expect(config.userDailyLimit).toBe(50);
    expect(config.taskLimit).toBe(10);
    expect(config.globalDailyLimit).toBe(1000);
  });

  it('falls back to defaults for invalid/non-positive values', () => {
    const config = parseWebSearchLimiterConfig({
      WEB_SEARCH_USER_DAILY_LIMIT: 'abc',
      WEB_SEARCH_TASK_LIMIT: '0',
      WEB_SEARCH_GLOBAL_DAILY_LIMIT: '-5',
    });
    expect(config.userDailyLimit).toBe(20);
    expect(config.taskLimit).toBe(5);
    expect(config.globalDailyLimit).toBe(200);
  });

  it('parses comma-separated allowlist', () => {
    const config = parseWebSearchLimiterConfig({
      WEB_SEARCH_ALLOWLIST_USERS: '1063093128, 42, 999',
    });
    expect(config.allowlistUsers.has('1063093128')).toBe(true);
    expect(config.allowlistUsers.has('42')).toBe(true);
    expect(config.allowlistUsers.has('999')).toBe(true);
    expect(config.allowlistUsers.size).toBe(3);
  });

  it('ignores empty entries in allowlist', () => {
    const config = parseWebSearchLimiterConfig({
      WEB_SEARCH_ALLOWLIST_USERS: ',,1,,2,',
    });
    expect(config.allowlistUsers.size).toBe(2);
    expect(config.allowlistUsers.has('1')).toBe(true);
    expect(config.allowlistUsers.has('2')).toBe(true);
  });
});

describe('createWebSearchLimiter', () => {
  let r2: ReturnType<typeof createMockR2>;

  beforeEach(() => {
    r2 = createMockR2();
  });

  it('allows the first search when all caps are fresh', async () => {
    const limiter = createWebSearchLimiter(
      { r2, userId: 'u1', taskId: 't1', now: fixedNow('2026-04-08T10:00:00Z') },
      defaultConfig,
    );
    const decision = await limiter.checkAndIncrement({ cached: false });
    expect(decision.allowed).toBe(true);
  });

  it('persists per-user and global counters to R2 on increment', async () => {
    const limiter = createWebSearchLimiter(
      { r2, userId: 'u1', taskId: 't1', now: fixedNow('2026-04-08T10:00:00Z') },
      defaultConfig,
    );
    await limiter.checkAndIncrement({ cached: false });
    expect(r2.store.get('ratelimit/web_search/users/u1/2026-04-08')).toBe('1');
    expect(r2.store.get('ratelimit/web_search/global/2026-04-08')).toBe('1');
  });

  it('does not count cached hits toward any cap', async () => {
    const limiter = createWebSearchLimiter(
      { r2, userId: 'u1', taskId: 't1', now: fixedNow('2026-04-08T10:00:00Z') },
      { ...defaultConfig, taskLimit: 1 },
    );
    // 5 cached hits in a row should all be allowed with task limit of 1
    for (let i = 0; i < 5; i++) {
      const decision = await limiter.checkAndIncrement({ cached: true });
      expect(decision.allowed).toBe(true);
    }
    // Counters never incremented
    expect(r2.store.has('ratelimit/web_search/users/u1/2026-04-08')).toBe(false);
    expect(r2.store.has('ratelimit/web_search/global/2026-04-08')).toBe(false);
    // And a non-cached call should still be allowed (task counter not consumed)
    const live = await limiter.checkAndIncrement({ cached: false });
    expect(live.allowed).toBe(true);
  });

  it('blocks with scope=task when per-task limit is reached', async () => {
    const limiter = createWebSearchLimiter(
      { r2, userId: 'u1', taskId: 't1', now: fixedNow('2026-04-08T10:00:00Z') },
      { ...defaultConfig, taskLimit: 3 },
    );
    // 3 allowed
    for (let i = 0; i < 3; i++) {
      const d = await limiter.checkAndIncrement({ cached: false });
      expect(d.allowed).toBe(true);
    }
    // 4th blocked on task scope
    const blocked = await limiter.checkAndIncrement({ cached: false });
    expect(blocked.allowed).toBe(false);
    if (blocked.allowed === false) {
      expect(blocked.scope).toBe('task');
      expect(blocked.reason).toContain('Per-task');
    }
  });

  it('blocks with scope=user when per-user daily limit is reached', async () => {
    // Pre-populate user counter to match the limit so the next call should block
    r2.store.set('ratelimit/web_search/users/u1/2026-04-08', '20');
    const limiter = createWebSearchLimiter(
      { r2, userId: 'u1', taskId: 't1', now: fixedNow('2026-04-08T10:00:00Z') },
      defaultConfig,
    );
    const blocked = await limiter.checkAndIncrement({ cached: false });
    expect(blocked.allowed).toBe(false);
    if (blocked.allowed === false) {
      expect(blocked.scope).toBe('user');
      expect(blocked.reason).toContain('20 searches/day');
    }
  });

  it('blocks with scope=global when global daily limit is reached', async () => {
    r2.store.set('ratelimit/web_search/global/2026-04-08', '200');
    const limiter = createWebSearchLimiter(
      { r2, userId: 'u1', taskId: 't1', now: fixedNow('2026-04-08T10:00:00Z') },
      defaultConfig,
    );
    const blocked = await limiter.checkAndIncrement({ cached: false });
    expect(blocked.allowed).toBe(false);
    if (blocked.allowed === false) {
      expect(blocked.scope).toBe('global');
      expect(blocked.reason).toContain('200 searches/day');
    }
  });

  it('allowlist bypasses all caps', async () => {
    r2.store.set('ratelimit/web_search/users/vip/2026-04-08', '9999');
    r2.store.set('ratelimit/web_search/global/2026-04-08', '9999');
    const limiter = createWebSearchLimiter(
      { r2, userId: 'vip', taskId: 't1', now: fixedNow('2026-04-08T10:00:00Z') },
      { ...defaultConfig, taskLimit: 1, allowlistUsers: new Set(['vip']) },
    );
    // Call way more times than any limit
    for (let i = 0; i < 50; i++) {
      const d = await limiter.checkAndIncrement({ cached: false });
      expect(d.allowed).toBe(true);
    }
  });

  it('different users have independent per-user counters', async () => {
    const limiterA = createWebSearchLimiter(
      { r2, userId: 'alice', taskId: 't1', now: fixedNow('2026-04-08T10:00:00Z') },
      defaultConfig,
    );
    const limiterB = createWebSearchLimiter(
      { r2, userId: 'bob', taskId: 't2', now: fixedNow('2026-04-08T10:00:00Z') },
      defaultConfig,
    );

    await limiterA.checkAndIncrement({ cached: false });
    await limiterA.checkAndIncrement({ cached: false });

    expect(r2.store.get('ratelimit/web_search/users/alice/2026-04-08')).toBe('2');
    expect(r2.store.has('ratelimit/web_search/users/bob/2026-04-08')).toBe(false);

    await limiterB.checkAndIncrement({ cached: false });
    expect(r2.store.get('ratelimit/web_search/users/bob/2026-04-08')).toBe('1');
  });

  it('different days have independent counters (natural expiry via date-scoped keys)', async () => {
    const day1Limiter = createWebSearchLimiter(
      { r2, userId: 'u1', taskId: 't1', now: fixedNow('2026-04-08T10:00:00Z') },
      defaultConfig,
    );
    const day2Limiter = createWebSearchLimiter(
      { r2, userId: 'u1', taskId: 't2', now: fixedNow('2026-04-09T10:00:00Z') },
      defaultConfig,
    );

    await day1Limiter.checkAndIncrement({ cached: false });
    await day2Limiter.checkAndIncrement({ cached: false });

    expect(r2.store.get('ratelimit/web_search/users/u1/2026-04-08')).toBe('1');
    expect(r2.store.get('ratelimit/web_search/users/u1/2026-04-09')).toBe('1');
  });

  it('sanitizes userId in R2 keys (prevents key injection)', async () => {
    const limiter = createWebSearchLimiter(
      { r2, userId: '../evil/path', taskId: 't1', now: fixedNow('2026-04-08T10:00:00Z') },
      defaultConfig,
    );
    await limiter.checkAndIncrement({ cached: false });
    // Sanitized: each of '.', '.', '/', '/' becomes '_' → '___evil_path'
    expect(r2.store.has('ratelimit/web_search/users/___evil_path/2026-04-08')).toBe(true);
    expect(r2.store.has('ratelimit/web_search/users/../evil/path/2026-04-08')).toBe(false);
  });

  it('treats R2 read failures as count=0 (degrades open, not closed)', async () => {
    const brokenR2 = {
      get: async () => {
        throw new Error('R2 unavailable');
      },
      put: async () => ({}) as R2Object,
    };
    const limiter = createWebSearchLimiter(
      { r2: brokenR2 as Pick<R2Bucket, 'get' | 'put'>, userId: 'u1', taskId: 't1', now: fixedNow('2026-04-08T10:00:00Z') },
      defaultConfig,
    );
    const decision = await limiter.checkAndIncrement({ cached: false });
    expect(decision.allowed).toBe(true);
  });
});
