import { describe, it, expect, vi } from 'vitest';
import { runScheduledAudits } from './audit-subs';
import type { AuditSubscription } from '../skills/audit/cache';
import type { MoltbotEnv } from '../types';

function makeSub(overrides: Partial<AuditSubscription> = {}): AuditSubscription {
  return {
    userId: 'user-1',
    owner: 'octocat',
    repo: 'demo',
    transport: 'telegram',
    chatId: 555,
    depth: 'quick',
    interval: 'weekly',
    createdAt: '2026-01-01T00:00:00Z',
    lastRunAt: null,
    lastRunId: null,
    ...overrides,
  };
}

/**
 * Build an env with a stub KV (in-memory) and a stub TASK_PROCESSOR
 * that records every fetch made to the DO. Returns the recordings
 * so tests can assert what was dispatched.
 */
function makeEnv(subs: AuditSubscription[]) {
  const store = new Map<string, string>();
  for (const s of subs) {
    store.set(`audit:sub:${s.userId}:${s.owner}/${s.repo}`, JSON.stringify(s));
  }
  const kv = {
    get: vi.fn(async (k: string, type?: string) => {
      const v = store.get(k);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    }),
    put: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
    }),
    delete: vi.fn(async (k: string) => {
      store.delete(k);
    }),
    list: vi.fn(async (opts: { prefix?: string }) => ({
      keys: [...store.keys()]
        .filter((k) => k.startsWith(opts.prefix ?? ''))
        .map((name) => ({ name })),
      list_complete: true,
    })),
  } as unknown as KVNamespace;

  const dispatched: { url: string; body: unknown }[] = [];
  const stubResponse = (status: number, body: string = '') => new Response(body, { status });

  let nextResponseStatus = 200;
  const setNextResponseStatus = (s: number) => {
    nextResponseStatus = s;
  };

  const taskProcessor = {
    idFromName: vi.fn((name: string) => ({ name }) as unknown as DurableObjectId),
    get: vi.fn(() => ({
      fetch: vi.fn(async (url: string, init?: RequestInit) => {
        dispatched.push({ url, body: JSON.parse(init?.body as string) });
        return stubResponse(nextResponseStatus, nextResponseStatus === 200 ? '' : 'mock failure');
      }),
    })),
  } as unknown as DurableObjectNamespace;

  const env = {
    NEXUS_KV: kv,
    TASK_PROCESSOR: taskProcessor,
    TELEGRAM_BOT_TOKEN: 'tg-token',
    OPENROUTER_API_KEY: 'or-key',
    GITHUB_TOKEN: 'gh-token',
  } as unknown as MoltbotEnv;

  return { env, store, dispatched, kv, setNextResponseStatus };
}

describe('runScheduledAudits', () => {
  it('skips everything when NEXUS_KV is not bound', async () => {
    const env = { TASK_PROCESSOR: {}, TELEGRAM_BOT_TOKEN: 't' } as unknown as MoltbotEnv;
    const r = await runScheduledAudits(env);
    expect(r).toEqual({ inspected: 0, dispatched: 0, skippedNotDue: 0, failed: 0 });
  });

  it('skips everything when TASK_PROCESSOR is not bound', async () => {
    const env = { NEXUS_KV: {}, TELEGRAM_BOT_TOKEN: 't' } as unknown as MoltbotEnv;
    const r = await runScheduledAudits(env);
    expect(r.dispatched).toBe(0);
  });

  it('skips everything when TELEGRAM_BOT_TOKEN is missing', async () => {
    const { env } = makeEnv([]);
    const stripped = { ...env, TELEGRAM_BOT_TOKEN: undefined } as unknown as MoltbotEnv;
    const r = await runScheduledAudits(stripped);
    expect(r.dispatched).toBe(0);
  });

  it('dispatches a never-run subscription', async () => {
    const { env, dispatched, store } = makeEnv([makeSub({ lastRunAt: null })]);
    const r = await runScheduledAudits(env);
    expect(r.inspected).toBe(1);
    expect(r.dispatched).toBe(1);
    expect(r.skippedNotDue).toBe(0);
    expect(dispatched).toHaveLength(1);
    const body = dispatched[0].body as {
      kind: string;
      chatId: number;
      userId: string;
      skillRequest: { text: string; flags: Record<string, string> };
    };
    expect(body.kind).toBe('skill');
    expect(body.chatId).toBe(555);
    expect(body.userId).toBe('user-1');
    expect(body.skillRequest.text).toBe('octocat/demo');
    expect(body.skillRequest.flags.analyze).toBe('true');

    // Stamped lastRunAt + lastRunId
    const stored = JSON.parse(store.get('audit:sub:user-1:octocat/demo')!) as AuditSubscription;
    expect(stored.lastRunAt).not.toBeNull();
    expect(stored.lastRunId).toBeTruthy();
  });

  it('skips a subscription whose cadence has not elapsed', async () => {
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
    const { env, dispatched } = makeEnv([makeSub({ interval: 'weekly', lastRunAt: recent })]);
    const r = await runScheduledAudits(env);
    expect(r.inspected).toBe(1);
    expect(r.dispatched).toBe(0);
    expect(r.skippedNotDue).toBe(1);
    expect(dispatched).toHaveLength(0);
  });

  it('mixes due and not-due subscriptions correctly', async () => {
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { env, dispatched } = makeEnv([
      makeSub({ owner: 'a', repo: 'a', lastRunAt: longAgo }),
      makeSub({ owner: 'b', repo: 'b', lastRunAt: recent }),
      makeSub({ owner: 'c', repo: 'c', lastRunAt: null }),
    ]);
    const r = await runScheduledAudits(env);
    expect(r.inspected).toBe(3);
    expect(r.dispatched).toBe(2);
    expect(r.skippedNotDue).toBe(1);
    const repos = new Set(
      dispatched.map((d) => (d.body as { skillRequest: { text: string } }).skillRequest.text),
    );
    expect(repos).toEqual(new Set(['a/a', 'c/c']));
  });

  it('counts a DO-side failure as failed without aborting other dispatches', async () => {
    const { env, dispatched, setNextResponseStatus } = makeEnv([
      makeSub({ owner: 'a', repo: 'a' }),
      makeSub({ owner: 'b', repo: 'b' }),
    ]);
    setNextResponseStatus(500);
    const r = await runScheduledAudits(env);
    expect(r.inspected).toBe(2);
    expect(r.failed).toBe(2);
    expect(r.dispatched).toBe(0);
    // Both were attempted — the second wasn't aborted by the first's failure.
    expect(dispatched).toHaveLength(2);
  });

  it('does not include the env binding in the wire payload', async () => {
    const { env, dispatched } = makeEnv([makeSub()]);
    await runScheduledAudits(env);
    const body = dispatched[0].body as { skillRequest: { env?: unknown } };
    // env is stripped — bindings can't cross the JSON serialization boundary.
    expect(body.skillRequest.env).toBeUndefined();
  });
});
