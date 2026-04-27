import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { createMockEnv } from '../test-utils';

describe('admin acontext sessions route', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns configured false when ACONTEXT_API_KEY is missing', async () => {
    const { api } = await import('./api');
    const app = new Hono<AppEnv>();
    app.route('/api', api);

    const response = await app.request(
      'http://localhost/api/admin/acontext/sessions',
      {
        method: 'GET',
      },
      createMockEnv({ DEV_MODE: 'true' }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [],
      configured: false,
    });
  });

  it('returns mapped session fields when configured', async () => {
    const listSessions = vi.fn().mockResolvedValue({
      items: [
        {
          id: 'sess_123',
          created_at: '2026-02-20T10:00:00.000Z',
          configs: {
            model: 'deepseek/deepseek-chat-v3.1',
            prompt: 'Investigate latency spike in worker logs',
            toolsUsed: 4,
            success: true,
          },
        },
      ],
      has_more: false,
      next_cursor: null,
    });

    vi.doMock('../acontext/client', () => ({
      createAcontextClient: vi.fn(() => ({ listSessions })),
    }));

    const { api } = await import('./api');
    const app = new Hono<AppEnv>();
    app.route('/api', api);

    const response = await app.request(
      'http://localhost/api/admin/acontext/sessions',
      {
        method: 'GET',
      },
      createMockEnv({ DEV_MODE: 'true', ACONTEXT_API_KEY: 'test-key' }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      configured: true,
      items: [
        {
          id: 'sess_123',
          model: 'deepseek/deepseek-chat-v3.1',
          prompt: 'Investigate latency spike in worker logs',
          toolsUsed: 4,
          success: true,
          createdAt: '2026-02-20T10:00:00.000Z',
        },
      ],
    });
    expect(listSessions).toHaveBeenCalledWith({ limit: 10, timeDesc: true });
  });
});

describe('admin analytics routes', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  function createMockR2ForAnalytics() {
    const learnings = {
      userId: 'u1',
      learnings: [
        {
          taskId: 't1',
          timestamp: 1710000000000,
          modelAlias: 'flash',
          category: 'web_search',
          toolsUsed: ['fetch_url', 'browse_url'],
          iterations: 2,
          durationMs: 5000,
          success: true,
          taskSummary: 'Find docs',
        },
      ],
      updatedAt: 1710000000000,
    };

    const orchestra = {
      userId: 'u1',
      tasks: [
        {
          taskId: 'o1',
          timestamp: 1710000001000,
          modelAlias: 'deep',
          repo: 'owner/repo',
          mode: 'run',
          prompt: 'Do work',
          branchName: 'bot/test',
          durationMs: 9000,
          prUrl: 'https://example.com/pr/1',
          status: 'completed',
          filesChanged: ['src/index.ts'],
          summary: 'Task complete',
        },
      ],
      updatedAt: 1710000001000,
    };

    const list = vi.fn(async ({ prefix }: { prefix: string }) => {
      if (prefix === 'learnings/') {
        return {
          objects: [{ key: 'learnings/u1/history.json' }],
          truncated: false,
          cursor: undefined,
        };
      }
      if (prefix === 'orchestra/') {
        return {
          objects: [{ key: 'orchestra/u1/history.json' }],
          truncated: false,
          cursor: undefined,
        };
      }
      return { objects: [], truncated: false, cursor: undefined };
    });

    const get = vi.fn(async (key: string) => {
      if (key === 'learnings/u1/history.json') {
        return { json: async () => learnings };
      }
      if (key === 'orchestra/u1/history.json') {
        return { json: async () => orchestra };
      }
      return null;
    });

    return { list, get } as unknown as R2Bucket;
  }

  it('returns aggregated overview analytics', async () => {
    const { api } = await import('./api');
    const app = new Hono<AppEnv>();
    app.route('/api', api);

    const response = await app.request(
      'http://localhost/api/admin/analytics/overview',
      { method: 'GET' },
      createMockEnv({ DEV_MODE: 'true', MOLTBOT_BUCKET: createMockR2ForAnalytics() }),
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as any;
    expect(json.totalTasks).toBe(1);
    expect(json.successRate).toBe(100);
    expect(json.tasksByCategory.web_search).toBe(1);
    expect(json.tasksByModel.flash).toBe(1);
    expect(json.toolUsage.fetch_url).toBe(1);
    expect(json.orchestraTasks.total).toBe(1);
    expect(json.orchestraTasks.completed).toBe(1);
  });

  it('returns detailed orchestra analytics', async () => {
    const { api } = await import('./api');
    const app = new Hono<AppEnv>();
    app.route('/api', api);

    const response = await app.request(
      'http://localhost/api/admin/analytics/orchestra',
      { method: 'GET' },
      createMockEnv({ DEV_MODE: 'true', MOLTBOT_BUCKET: createMockR2ForAnalytics() }),
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as any;
    expect(json.tasks).toHaveLength(1);
    expect(json.tasks[0].repo).toBe('owner/repo');
    expect(json.tasks[0].status).toBe('completed');
    expect(json.repoStats['owner/repo']).toEqual({ total: 1, completed: 1, failed: 0 });
  });
});

describe('POST /api/skills/execute', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns 401 without valid X-Storia-Secret', async () => {
    const { api } = await import('./api');
    const app = new Hono<AppEnv>();
    app.route('/api', api);

    const response = await app.request(
      'http://localhost/api/skills/execute',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillId: 'orchestra', subcommand: 'status' }),
      },
      createMockEnv({ STORIA_MOLTWORKER_SECRET: 'real-secret' }),
    );

    expect(response.status).toBe(401);
    const json = (await response.json()) as any;
    expect(json.error).toBe('Unauthorized');
  });

  it('executes registered skill and returns result envelope', async () => {
    const { api } = await import('./api');
    const app = new Hono<AppEnv>();
    app.route('/api', api);

    const response = await app.request(
      'http://localhost/api/skills/execute',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Storia-Secret': 'test-secret',
        },
        body: JSON.stringify({ skillId: 'orchestra', subcommand: 'status', text: 'hello' }),
      },
      createMockEnv({ STORIA_MOLTWORKER_SECRET: 'test-secret' }),
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as any;
    expect(json.ok).toBe(true);
    expect(json.skillId).toBe('orchestra');
    expect(json.kind).toBe('orchestra');
    expect(json.telemetry).toBeDefined();
    expect(json.telemetry.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns 500 for unregistered skill', async () => {
    const { api } = await import('./api');
    const app = new Hono<AppEnv>();
    app.route('/api', api);

    const response = await app.request(
      'http://localhost/api/skills/execute',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Storia-Secret': 'test-secret',
        },
        body: JSON.stringify({ skillId: 'nonexistent', subcommand: 'test', text: 'test' }),
      },
      createMockEnv({ STORIA_MOLTWORKER_SECRET: 'test-secret' }),
    );

    expect(response.status).toBe(500);
    const json = (await response.json()) as any;
    expect(json.ok).toBe(false);
    expect(json.kind).toBe('error');
    expect(json.body).toContain('Unknown skill');
  });

  it('returns 400 for missing required fields', async () => {
    const { api } = await import('./api');
    const app = new Hono<AppEnv>();
    app.route('/api', api);

    const response = await app.request(
      'http://localhost/api/skills/execute',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Storia-Secret': 'test-secret',
        },
        body: JSON.stringify({ text: 'hello' }),
      },
      createMockEnv({ STORIA_MOLTWORKER_SECRET: 'test-secret' }),
    );

    expect(response.status).toBe(400);
    const json = (await response.json()) as any;
    expect(json.error).toContain('Missing required fields');
  });
});

// ---------------------------------------------------------------------------
// Audit admin tab routes (Phase 1, Slice B)
// ---------------------------------------------------------------------------

describe('admin audit routes', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  function makeKV(initial: Record<string, { value: string; metadata?: unknown }> = {}) {
    const store = new Map<string, string>();
    const meta = new Map<string, unknown>();
    for (const [k, v] of Object.entries(initial)) {
      store.set(k, v.value);
      if (v.metadata !== undefined) meta.set(k, v.metadata);
    }
    return {
      get: vi.fn(async (k: string, type?: string) => {
        const v = store.get(k);
        if (v === undefined) return null;
        return type === 'json' ? JSON.parse(v) : v;
      }),
      put: vi.fn(async (k: string, v: string, opts?: { metadata?: unknown }) => {
        store.set(k, v);
        if (opts?.metadata !== undefined) meta.set(k, opts.metadata);
      }),
      delete: vi.fn(async (k: string) => {
        store.delete(k);
        meta.delete(k);
      }),
      list: vi.fn(async (opts: { prefix?: string }) => ({
        keys: [...store.keys()]
          .filter((k) => k.startsWith(opts.prefix ?? ''))
          .map((name) => ({ name, metadata: meta.get(name) })),
        list_complete: true,
      })),
    } as unknown as KVNamespace;
  }

  it('GET /audit/overview returns 503 when NEXUS_KV is not bound', async () => {
    const { api } = await import('./api');
    const app = new Hono<AppEnv>();
    app.route('/api', api);

    const response = await app.request(
      'http://localhost/api/admin/audit/overview',
      { method: 'GET' },
      createMockEnv({ DEV_MODE: 'true' }),
    );
    expect(response.status).toBe(503);
  });

  it('GET /audit/overview aggregates subscriptions, runs, and suppressions', async () => {
    const sub = {
      userId: 'u1',
      owner: 'octocat',
      repo: 'demo',
      transport: 'telegram',
      chatId: 1,
      depth: 'quick',
      interval: 'weekly',
      createdAt: '2026-01-01T00:00:00Z',
      lastRunAt: null,
      lastTaskId: null,
      lastRunId: null,
    };
    const run = {
      runId: 'r1',
      repo: { owner: 'octocat', name: 'demo', sha: 'a'.repeat(40) },
      lenses: ['security'],
      depth: 'quick',
      findings: [],
      telemetry: {
        durationMs: 100,
        llmCalls: 1,
        tokensIn: 10,
        tokensOut: 5,
        costUsd: 0.01,
        githubApiCalls: 1,
      },
    };
    const kv = makeKV({
      'audit:sub:u1:octocat/demo': { value: JSON.stringify(sub) },
      'audit:run:u1:r1': {
        value: JSON.stringify(run),
        metadata: { createdAtMs: Date.now(), owner: 'octocat', repo: 'demo' },
      },
      'audit:suppressed:u1:octocat/demo:security-abc': {
        value: JSON.stringify({ at: '2026-04-20T00:00:00Z' }),
      },
    });

    const { api } = await import('./api');
    const app = new Hono<AppEnv>();
    app.route('/api', api);

    const response = await app.request(
      'http://localhost/api/admin/audit/overview',
      { method: 'GET' },
      createMockEnv({ DEV_MODE: 'true', NEXUS_KV: kv }),
    );
    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      subscriptions: unknown[];
      recentRuns: unknown[];
      suppressions: unknown[];
    };
    expect(json.subscriptions).toHaveLength(1);
    expect(json.recentRuns).toHaveLength(1);
    expect(json.suppressions).toHaveLength(1);
  });

  it('DELETE /audit/subscriptions removes the subscription and reports removed=true', async () => {
    const sub = {
      userId: 'u1',
      owner: 'octocat',
      repo: 'demo',
      transport: 'telegram',
      chatId: 1,
      depth: 'quick',
      interval: 'weekly',
      createdAt: 't',
      lastRunAt: null,
      lastTaskId: null,
      lastRunId: null,
    };
    const kv = makeKV({ 'audit:sub:u1:octocat/demo': { value: JSON.stringify(sub) } });

    const { api } = await import('./api');
    const app = new Hono<AppEnv>();
    app.route('/api', api);

    const response = await app.request(
      'http://localhost/api/admin/audit/subscriptions/u1/octocat/demo',
      { method: 'DELETE' },
      createMockEnv({ DEV_MODE: 'true', NEXUS_KV: kv }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ removed: true });
  });

  it('DELETE /audit/subscriptions rejects unsafe path segments (key injection guard)', async () => {
    const kv = makeKV();
    const { api } = await import('./api');
    const app = new Hono<AppEnv>();
    app.route('/api', api);

    // Slash + colon are reserved for KV key construction. Hono URL-decodes
    // before routing, so these end up as raw segment values.
    const response = await app.request(
      'http://localhost/api/admin/audit/subscriptions/u1/octocat/demo%3Aevil',
      { method: 'DELETE' },
      createMockEnv({ DEV_MODE: 'true', NEXUS_KV: kv }),
    );
    expect(response.status).toBe(400);
  });

  it('DELETE /audit/suppressions un-suppresses a finding and reports the new total', async () => {
    const kv = makeKV({
      'audit:suppressed:u1:octocat/demo:security-abc': {
        value: JSON.stringify({ at: '2026-04-20T00:00:00Z' }),
      },
      'audit:suppressed:u1:octocat/demo:types-xyz': {
        value: JSON.stringify({ at: '2026-04-21T00:00:00Z' }),
      },
    });

    const { api } = await import('./api');
    const app = new Hono<AppEnv>();
    app.route('/api', api);

    const response = await app.request(
      'http://localhost/api/admin/audit/suppressions/u1/octocat/demo/security-abc',
      { method: 'DELETE' },
      createMockEnv({ DEV_MODE: 'true', NEXUS_KV: kv }),
    );
    expect(response.status).toBe(200);
    const json = (await response.json()) as { removed: boolean; total: number };
    expect(json.removed).toBe(true);
    expect(json.total).toBe(1); // one suppression left for this repo
  });

  it('DELETE /audit/suppressions rejects malformed findingId', async () => {
    const kv = makeKV();
    const { api } = await import('./api');
    const app = new Hono<AppEnv>();
    app.route('/api', api);

    const response = await app.request(
      'http://localhost/api/admin/audit/suppressions/u1/octocat/demo/NOT-A-VALID-ID',
      { method: 'DELETE' },
      createMockEnv({ DEV_MODE: 'true', NEXUS_KV: kv }),
    );
    expect(response.status).toBe(400);
  });
});
