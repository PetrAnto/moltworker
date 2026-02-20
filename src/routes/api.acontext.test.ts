import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockEnv } from '../test-utils';

const listSessionsMock = vi.fn();
const createAcontextClientMock = vi.fn();

vi.mock('../acontext/client', () => ({
  createAcontextClient: createAcontextClientMock,
}));

describe('GET /api/admin/acontext/sessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns configured false when Acontext client is unavailable', async () => {
    createAcontextClientMock.mockReturnValue(null);
    const { api } = await import('./api');

    const response = await api.request('/admin/acontext/sessions', {}, createMockEnv({ DEV_MODE: 'true' }));
    const body = await response.json() as { configured: boolean; items: unknown[] };

    expect(response.status).toBe(200);
    expect(body).toEqual({ configured: false, items: [] });
    expect(createAcontextClientMock).toHaveBeenCalled();
    expect(listSessionsMock).not.toHaveBeenCalled();
  });

  it('returns normalized recent sessions when configured', async () => {
    listSessionsMock.mockResolvedValue({
      items: [
        {
          id: 'sess_123',
          created_at: '2026-02-20T10:00:00.000Z',
          configs: {
            model: 'openrouter/claude-sonnet',
            prompt: 'Investigate worker issue and summarize root cause',
            toolsUsed: 3,
            success: true,
          },
        },
      ],
      has_more: false,
    });
    createAcontextClientMock.mockReturnValue({ listSessions: listSessionsMock });

    const { api } = await import('./api');
    const response = await api.request('/admin/acontext/sessions', {}, createMockEnv({ DEV_MODE: 'true', ACONTEXT_API_KEY: 'test-key' }));
    const body = await response.json() as { configured: boolean; items: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(listSessionsMock).toHaveBeenCalledWith({ limit: 10, timeDesc: true });
    expect(body).toEqual({
      configured: true,
      items: [
        {
          id: 'sess_123',
          model: 'openrouter/claude-sonnet',
          prompt: 'Investigate worker issue and summarize root cause',
          toolsUsed: 3,
          success: true,
          createdAt: '2026-02-20T10:00:00.000Z',
        },
      ],
    });
  });
});
