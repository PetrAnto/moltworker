import { describe, expect, it, vi, beforeEach } from 'vitest'

const listSessionsMock = vi.fn()

vi.mock('../auth', () => ({
  createAccessMiddleware: () => async (_c: unknown, next: () => Promise<void>) => {
    await next()
  },
}))

vi.mock('../acontext/client', () => ({
  createAcontextClient: vi.fn(),
}))

import { createAcontextClient } from '../acontext/client'
import { api } from './api'

describe('GET /api/admin/acontext/sessions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listSessionsMock.mockReset()
  })

  it('returns configured false when API key is missing', async () => {
    vi.mocked(createAcontextClient).mockReturnValue(null)

    const res = await api.request('http://localhost/admin/acontext/sessions', {
      method: 'GET',
    }, {
      ACONTEXT_API_KEY: undefined,
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ items: [], configured: false })
    expect(createAcontextClient).toHaveBeenCalledWith(undefined)
  })

  it('returns mapped sessions when configured', async () => {
    listSessionsMock.mockResolvedValue({
      items: [
        {
          id: 'sess_123',
          created_at: '2026-02-20T10:00:00.000Z',
          configs: {
            model: 'anthropic/claude-sonnet-4',
            prompt: 'Write release notes',
            toolsUsed: 3,
            success: true,
          },
        },
      ],
    })

    vi.mocked(createAcontextClient).mockReturnValue({
      listSessions: listSessionsMock,
    } as never)

    const res = await api.request('http://localhost/admin/acontext/sessions', {
      method: 'GET',
    }, {
      ACONTEXT_API_KEY: 'test-key',
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      configured: true,
      items: [
        {
          id: 'sess_123',
          model: 'anthropic/claude-sonnet-4',
          prompt: 'Write release notes',
          toolsUsed: 3,
          success: true,
          createdAt: '2026-02-20T10:00:00.000Z',
        },
      ],
    })
    expect(listSessionsMock).toHaveBeenCalledWith({ limit: 10, timeDesc: true })
  })
})
