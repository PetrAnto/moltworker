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
        return { objects: [{ key: 'learnings/u1/history.json' }], truncated: false, cursor: undefined };
      }
      if (prefix === 'orchestra/') {
        return { objects: [{ key: 'orchestra/u1/history.json' }], truncated: false, cursor: undefined };
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

    const response = await app.request('http://localhost/api/admin/analytics/overview', { method: 'GET' }, createMockEnv({ DEV_MODE: 'true', MOLTBOT_BUCKET: createMockR2ForAnalytics() }));

    expect(response.status).toBe(200);
    const json = await response.json() as any;
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

    const response = await app.request('http://localhost/api/admin/analytics/orchestra', { method: 'GET' }, createMockEnv({ DEV_MODE: 'true', MOLTBOT_BUCKET: createMockR2ForAnalytics() }));

    expect(response.status).toBe(200);
    const json = await response.json() as any;
    expect(json.tasks).toHaveLength(1);
    expect(json.tasks[0].repo).toBe('owner/repo');
    expect(json.tasks[0].status).toBe('completed');
    expect(json.repoStats['owner/repo']).toEqual({ total: 1, completed: 1, failed: 0 });
  });
});
