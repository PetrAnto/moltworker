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

  it('returns aggregated analytics overview', async () => {
    const r2 = {
      list: vi.fn()
        .mockResolvedValueOnce({
          objects: [{ key: 'learnings/u1/history.json' }],
          truncated: false,
          cursor: undefined,
        })
        .mockResolvedValueOnce({
          objects: [{ key: 'orchestra/u1/history.json' }],
          truncated: false,
          cursor: undefined,
        }),
      get: vi.fn(async (key: string) => {
        if (key === 'learnings/u1/history.json') {
          return {
            json: async () => ({
              learnings: [
                {
                  timestamp: 1730000000000,
                  modelAlias: 'flash',
                  category: 'web_search',
                  success: true,
                  durationMs: 5000,
                  taskSummary: 'Find docs',
                  toolsUsed: ['fetch_url', 'browse_url'],
                },
              ],
            }),
          };
        }

        if (key === 'orchestra/u1/history.json') {
          return {
            json: async () => ({
              tasks: [
                {
                  taskId: 'orch1',
                  timestamp: 1730001000000,
                  repo: 'owner/repo',
                  mode: 'run',
                  status: 'completed',
                  modelAlias: 'deep',
                  durationMs: 10000,
                  filesChanged: ['a.ts'],
                },
              ],
            }),
          };
        }

        return null;
      }),
    } as unknown as R2Bucket;

    const { api } = await import('./api');
    const app = new Hono<AppEnv>();
    app.route('/api', api);

    const response = await app.request('http://localhost/api/admin/analytics/overview', {
      method: 'GET',
    }, createMockEnv({ DEV_MODE: 'true', MOLTBOT_BUCKET: r2 }));

    expect(response.status).toBe(200);
    const body = await response.json() as {
      totalTasks: number;
      successRate: number;
      tasksByCategory: Record<string, number>;
      orchestraTasks: { total: number; completed: number; byRepo: Record<string, number> };
    };

    expect(body.totalTasks).toBe(1);
    expect(body.successRate).toBe(100);
    expect(body.tasksByCategory.web_search).toBe(1);
    expect(body.orchestraTasks.total).toBe(1);
    expect(body.orchestraTasks.completed).toBe(1);
    expect(body.orchestraTasks.byRepo['owner/repo']).toBe(1);
  });

  it('returns orchestra analytics details', async () => {
    const r2 = {
      list: vi.fn().mockResolvedValue({
        objects: [{ key: 'orchestra/u1/history.json' }],
        truncated: false,
        cursor: undefined,
      }),
      get: vi.fn(async () => ({
        json: async () => ({
          tasks: [
            {
              taskId: 'orch1',
              timestamp: 1730001000000,
              repo: 'owner/repo',
              mode: 'run',
              status: 'failed',
              modelAlias: 'deep',
              filesChanged: ['a.ts', 'b.ts'],
            },
          ],
        }),
      })),
    } as unknown as R2Bucket;

    const { api } = await import('./api');
    const app = new Hono<AppEnv>();
    app.route('/api', api);

    const response = await app.request('http://localhost/api/admin/analytics/orchestra', {
      method: 'GET',
    }, createMockEnv({ DEV_MODE: 'true', MOLTBOT_BUCKET: r2 }));

    expect(response.status).toBe(200);
    const body = await response.json() as {
      tasks: Array<{ status: string; repo: string }>;
      repoStats: Record<string, { failed: number; total: number }>;
    };

    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0].status).toBe('failed');
    expect(body.repoStats['owner/repo'].failed).toBe(1);
    expect(body.repoStats['owner/repo'].total).toBe(1);
  });
});
