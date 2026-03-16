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

  it('aggregates analytics overview from R2 histories', async () => {
    const bucket = {
      list: vi
        .fn()
        .mockResolvedValueOnce({ objects: [{ key: 'learnings/u1/history.json' }], truncated: false })
        .mockResolvedValueOnce({ objects: [{ key: 'orchestra/u1/history.json' }], truncated: false }),
      get: vi
        .fn()
        .mockResolvedValueOnce({
          json: async () => ({
            learnings: [
              {
                timestamp: 1000,
                modelAlias: 'flash',
                category: 'github',
                toolsUsed: ['github_read_file'],
                durationMs: 4200,
                success: true,
                taskSummary: 'Read file',
              },
            ],
          }),
        })
        .mockResolvedValueOnce({
          json: async () => ({
            tasks: [
              { taskId: 't1', timestamp: 1001, modelAlias: 'deep', repo: 'a/b', mode: 'run', status: 'completed', filesChanged: [] },
            ],
          }),
        }),
    } as unknown as R2Bucket;

    const { api } = await import('./api');
    const app = new Hono<AppEnv>();
    app.route('/api', api);

    const response = await app.request('http://localhost/api/admin/analytics/overview', { method: 'GET' }, createMockEnv({ DEV_MODE: 'true', MOLTBOT_BUCKET: bucket }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      totalTasks: 1,
      successRate: 100,
      avgDurationMs: 4200,
      tasksByCategory: { github: 1 },
      tasksByModel: { flash: 1 },
      orchestraTasks: { total: 1, completed: 1, failed: 0, byRepo: { 'a/b': 1 } },
    });
  });

  it('returns orchestra analytics details', async () => {
    const bucket = {
      list: vi.fn().mockResolvedValue({ objects: [{ key: 'orchestra/u1/history.json' }], truncated: false }),
      get: vi.fn().mockResolvedValue({
        json: async () => ({
          tasks: [
            {
              taskId: 'o1',
              timestamp: 100,
              modelAlias: 'flash',
              repo: 'org/repo',
              mode: 'init',
              status: 'failed',
              summary: 'oops',
              filesChanged: ['README.md'],
            },
          ],
        }),
      }),
    } as unknown as R2Bucket;

    const { api } = await import('./api');
    const app = new Hono<AppEnv>();
    app.route('/api', api);

    const response = await app.request('http://localhost/api/admin/analytics/orchestra', { method: 'GET' }, createMockEnv({ DEV_MODE: 'true', MOLTBOT_BUCKET: bucket }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      tasks: [
        {
          taskId: 'o1',
          timestamp: 100,
          repo: 'org/repo',
          mode: 'init',
          status: 'failed',
          model: 'flash',
          durationMs: undefined,
          prUrl: undefined,
          summary: 'oops',
          filesChanged: ['README.md'],
        },
      ],
      repoStats: {
        'org/repo': { total: 1, completed: 0, failed: 1 },
      },
    });
  });
});
