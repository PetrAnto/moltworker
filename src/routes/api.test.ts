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

    const response = await app.request('http://localhost/api/admin/acontext/sessions', {
      method: 'GET',
    }, createMockEnv({ DEV_MODE: 'true' }));

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

    const response = await app.request('http://localhost/api/admin/acontext/sessions', {
      method: 'GET',
    }, createMockEnv({ DEV_MODE: 'true', ACONTEXT_API_KEY: 'test-key' }));

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

  it('aggregates overview analytics from R2 histories', async () => {
    const learningPayload = {
      learnings: [
        {
          timestamp: 1700000000100,
          modelAlias: 'deep',
          category: 'web_search',
          toolsUsed: ['fetch_url', 'web_search'],
          durationMs: 2300,
          success: true,
          taskSummary: 'Summarize homepage',
        },
        {
          timestamp: 1700000000000,
          modelAlias: 'flash',
          category: 'github',
          toolsUsed: ['github_read_file'],
          durationMs: 4000,
          success: false,
          taskSummary: 'Inspect workflow file',
        },
      ],
    };

    const orchestraPayload = {
      tasks: [
        {
          taskId: 'orch-1',
          timestamp: 1700000000200,
          modelAlias: 'deep',
          repo: 'org/repo-a',
          mode: 'run',
          status: 'completed',
          filesChanged: ['src/a.ts'],
        },
        {
          taskId: 'orch-2',
          timestamp: 1700000000300,
          modelAlias: 'flash',
          repo: 'org/repo-a',
          mode: 'redo',
          status: 'failed',
          filesChanged: ['src/b.ts'],
        },
      ],
    };

    const listMock = vi.fn(async ({ prefix }: { prefix: string }) => {
      if (prefix === 'learnings/') {
        return { objects: [{ key: 'learnings/u1/history.json' }], truncated: false };
      }
      return { objects: [{ key: 'orchestra/u1/history.json' }], truncated: false };
    });

    const getMock = vi.fn(async (key: string) => {
      if (key.startsWith('learnings/')) {
        return { json: async () => learningPayload };
      }

      if (key.startsWith('orchestra/')) {
        return { json: async () => orchestraPayload };
      }

      return null;
    });

    const { api } = await import('./api');
    const app = new Hono<AppEnv>();
    app.route('/api', api);

    const response = await app.request(
      'http://localhost/api/admin/analytics/overview',
      { method: 'GET' },
      createMockEnv({ DEV_MODE: 'true', MOLTBOT_BUCKET: { list: listMock, get: getMock } as unknown as R2Bucket }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      totalTasks: 2,
      successRate: 50,
      avgDurationMs: 3150,
      tasksByCategory: { web_search: 1, github: 1 },
      tasksByModel: { deep: 1, flash: 1 },
      toolUsage: { fetch_url: 1, web_search: 1, github_read_file: 1 },
      orchestraTasks: {
        total: 2,
        completed: 1,
        failed: 1,
        byRepo: { 'org/repo-a': 2 },
      },
    });
  });

  it('returns detailed orchestra analytics and repo stats', async () => {
    const listMock = vi.fn(async () => ({
      objects: [{ key: 'orchestra/u1/history.json' }],
      truncated: false,
    }));

    const getMock = vi.fn(async () => ({
      json: async () => ({
        tasks: [
          {
            taskId: 'orch-a',
            timestamp: 1700000001000,
            modelAlias: 'deep',
            repo: 'org/repo-a',
            mode: 'run',
            status: 'completed',
            filesChanged: ['README.md'],
            summary: 'Merged PR',
          },
          {
            taskId: 'orch-b',
            timestamp: 1700000002000,
            modelAlias: 'flash',
            repo: 'org/repo-b',
            mode: 'redo',
            status: 'failed',
            filesChanged: ['src/index.ts'],
          },
        ],
      }),
    }));

    const { api } = await import('./api');
    const app = new Hono<AppEnv>();
    app.route('/api', api);

    const response = await app.request(
      'http://localhost/api/admin/analytics/orchestra',
      { method: 'GET' },
      createMockEnv({ DEV_MODE: 'true', MOLTBOT_BUCKET: { list: listMock, get: getMock } as unknown as R2Bucket }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      tasks: [
        {
          taskId: 'orch-b',
          repo: 'org/repo-b',
          status: 'failed',
          mode: 'redo',
          model: 'flash',
        },
        {
          taskId: 'orch-a',
          repo: 'org/repo-a',
          status: 'completed',
          mode: 'run',
          model: 'deep',
        },
      ],
      repoStats: {
        'org/repo-a': { total: 1, completed: 1, failed: 0 },
        'org/repo-b': { total: 1, completed: 0, failed: 1 },
      },
    });
  });
});
