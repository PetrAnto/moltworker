import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listSessionsMock, createAcontextClientMock } = vi.hoisted(() => ({
  listSessionsMock: vi.fn(),
  createAcontextClientMock: vi.fn(),
}));

vi.mock('../auth', () => ({
  createAccessMiddleware: () => {
    return async (_c: unknown, next: () => Promise<void>) => {
      await next();
    };
  },
}));

vi.mock('../acontext/client', () => ({
  createAcontextClient: createAcontextClientMock,
}));

import { api } from './api';
import { createMockEnv } from '../test-utils';

describe('GET /api/admin/acontext/sessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns configured=false when Acontext client is unavailable', async () => {
    createAcontextClientMock.mockReturnValue(null);

    const response = await api.request('/admin/acontext/sessions', {}, createMockEnv());
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ items: [], configured: false });
    expect(createAcontextClientMock).toHaveBeenCalledOnce();
  });

  it('returns mapped sessions when configured', async () => {
    listSessionsMock.mockResolvedValue({
      items: [
        {
          id: 'sess-1',
          created_at: '2026-02-19T10:00:00.000Z',
          configs: {
            model: 'openrouter/openai/gpt-5',
            taskPrompt: 'Implement the dashboard feature',
            toolsUsed: 4,
            success: true,
          },
        },
      ],
      has_more: false,
    });
    createAcontextClientMock.mockReturnValue({ listSessions: listSessionsMock });

    const response = await api.request(
      '/admin/acontext/sessions',
      {},
      createMockEnv({ ACONTEXT_API_KEY: 'test-key' }),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(listSessionsMock).toHaveBeenCalledWith({ limit: 10, timeDesc: true });
    expect(data).toEqual({
      configured: true,
      items: [
        {
          id: 'sess-1',
          model: 'openrouter/openai/gpt-5',
          prompt: 'Implement the dashboard feature',
          toolsUsed: 4,
          success: true,
          createdAt: '2026-02-19T10:00:00.000Z',
        },
      ],
    });
  });
});
