/**
 * Tests for Acontext REST client
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AcontextClient, createAcontextClient, toOpenAIMessages, formatSessionsList, type AcontextSession, type OpenAIMessage } from './client';

// --- Mock fetch ---

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

// --- AcontextClient ---

describe('AcontextClient', () => {
  const client = new AcontextClient('test-api-key', 'https://api.test.com');

  describe('createSession', () => {
    it('sends POST with correct headers and body', async () => {
      const session: AcontextSession = {
        id: 'sess-123',
        project_id: 'proj-1',
        user_id: 'user-1',
        configs: { model: 'gpt-4' },
        created_at: '2026-02-18T00:00:00Z',
        updated_at: '2026-02-18T00:00:00Z',
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(session));

      const result = await client.createSession({ user: 'user-1', configs: { model: 'gpt-4' } });

      expect(result).toEqual(session);
      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.test.com/api/v1/sessions');
      expect(opts.method).toBe('POST');
      expect(opts.headers['Authorization']).toBe('Bearer test-api-key');
      expect(opts.headers['User-Agent']).toBe('moltworker/1.0');
      const body = JSON.parse(opts.body);
      expect(body.user).toBe('user-1');
      expect(body.configs.model).toBe('gpt-4');
    });
  });

  describe('storeMessage', () => {
    it('stores a message with blob and meta', async () => {
      const msg = { id: 'msg-1', session_id: 'sess-1', role: 'user', created_at: '2026-02-18T00:00:00Z' };
      mockFetch.mockResolvedValueOnce(jsonResponse(msg));

      const blob: OpenAIMessage = { role: 'user', content: 'Hello' };
      const result = await client.storeMessage('sess-1', blob, { taskId: 't1' });

      expect(result).toEqual(msg);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.test.com/api/v1/sessions/sess-1/messages');
      const body = JSON.parse(opts.body);
      expect(body.blob).toEqual(blob);
      expect(body.format).toBe('openai');
      expect(body.meta.taskId).toBe('t1');
    });
  });

  describe('storeMessages', () => {
    it('stores multiple messages and counts successes/errors', async () => {
      const msg = { id: 'msg-1', session_id: 'sess-1', role: 'user', created_at: '2026-02-18T00:00:00Z' };
      // First succeeds, second fails, third succeeds
      mockFetch.mockResolvedValueOnce(jsonResponse(msg));
      mockFetch.mockResolvedValueOnce(errorResponse(500, 'Internal error'));
      mockFetch.mockResolvedValueOnce(jsonResponse(msg));

      const messages: OpenAIMessage[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
        { role: 'user', content: 'Bye' },
      ];

      // Suppress console.error for expected error
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const result = await client.storeMessages('sess-1', messages);
      spy.mockRestore();

      expect(result.stored).toBe(2);
      expect(result.errors).toBe(1);
    });
  });

  describe('updateConfigs', () => {
    it('sends PATCH with configs', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ model: 'gpt-4', success: true }));

      const result = await client.updateConfigs('sess-1', { success: true });

      expect(result).toEqual({ model: 'gpt-4', success: true });
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.test.com/api/v1/sessions/sess-1/configs');
      expect(opts.method).toBe('PATCH');
    });
  });

  describe('listSessions', () => {
    it('sends GET with query params', async () => {
      const sessions = { items: [], has_more: false };
      mockFetch.mockResolvedValueOnce(jsonResponse(sessions));

      await client.listSessions({ user: 'u1', limit: 5, timeDesc: true });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('user=u1');
      expect(url).toContain('limit=5');
      expect(url).toContain('time_desc=true');
    });

    it('sends GET without query params when none provided', async () => {
      const sessions = { items: [], has_more: false };
      mockFetch.mockResolvedValueOnce(jsonResponse(sessions));

      await client.listSessions();

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.test.com/api/v1/sessions');
    });
  });

  describe('deleteSession', () => {
    it('sends DELETE and handles 204', async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

      await client.deleteSession('sess-1');

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.test.com/api/v1/sessions/sess-1');
      expect(opts.method).toBe('DELETE');
    });
  });

  describe('error handling', () => {
    it('throws on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(403, 'Forbidden'));

      await expect(client.createSession({ user: 'u1' })).rejects.toThrow('403 Forbidden');
    });

    it('handles timeout via AbortController', async () => {
      const slowClient = new AcontextClient('key', 'https://api.test.com', 50);
      mockFetch.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 200)));

      await expect(slowClient.createSession({ user: 'u1' })).rejects.toThrow();
    });
  });

  describe('base URL normalization', () => {
    it('strips trailing slashes', () => {
      const c = new AcontextClient('key', 'https://api.test.com///');
      // Access private baseUrl indirectly via a request
      mockFetch.mockResolvedValueOnce(jsonResponse({ items: [], has_more: false }));
      c.listSessions();
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('https://api.test.com/api/v1');
    });
  });
});

// --- createAcontextClient ---

describe('createAcontextClient', () => {
  it('returns null when no API key', () => {
    expect(createAcontextClient()).toBeNull();
    expect(createAcontextClient('')).toBeNull();
    expect(createAcontextClient(undefined)).toBeNull();
  });

  it('returns client when API key is provided', () => {
    const client = createAcontextClient('test-key');
    expect(client).toBeInstanceOf(AcontextClient);
  });

  it('passes custom base URL', async () => {
    const client = createAcontextClient('test-key', 'https://custom.api.com');
    expect(client).toBeInstanceOf(AcontextClient);
    // Verify by making a request
    mockFetch.mockResolvedValueOnce(jsonResponse({ items: [], has_more: false }));
    await client!.listSessions();
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('custom.api.com');
  });
});

// --- toOpenAIMessages ---

describe('toOpenAIMessages', () => {
  it('converts basic messages', () => {
    const messages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ];
    const result = toOpenAIMessages(messages);
    expect(result).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ]);
  });

  it('truncates long content', () => {
    const longContent = 'A'.repeat(5000);
    const result = toOpenAIMessages([{ role: 'tool', content: longContent }]);
    expect(result[0].content!.length).toBeLessThan(5000);
    expect(result[0].content).toContain('... [truncated]');
  });

  it('preserves tool_call_id', () => {
    const result = toOpenAIMessages([{ role: 'tool', content: 'result', tool_call_id: 'call-1' }]);
    expect(result[0].tool_call_id).toBe('call-1');
  });

  it('preserves name field', () => {
    const result = toOpenAIMessages([{ role: 'tool', content: 'result', name: 'web_fetch' }]);
    expect(result[0].name).toBe('web_fetch');
  });

  it('handles null content', () => {
    const result = toOpenAIMessages([{ role: 'assistant', content: null }]);
    expect(result[0].content).toBeUndefined();
  });

  it('converts non-string content to string', () => {
    const result = toOpenAIMessages([{ role: 'user', content: 42 as unknown as string }]);
    expect(result[0].content).toBe('42');
  });
});

// --- formatSessionsList ---

describe('formatSessionsList', () => {
  it('returns empty message for no sessions', () => {
    const result = formatSessionsList([]);
    expect(result).toContain('No sessions found');
  });

  it('formats sessions with model, tools, and age', () => {
    const now = new Date();
    const sessions: AcontextSession[] = [
      {
        id: 'sess-12345678-abcd',
        project_id: 'proj-1',
        user_id: 'u1',
        configs: {
          model: 'sonnet',
          prompt: 'Write a function to sort arrays',
          success: true,
          toolsUsed: 5,
        },
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      },
    ];

    const result = formatSessionsList(sessions);
    expect(result).toContain('Recent Acontext Sessions');
    expect(result).toContain('sonnet');
    expect(result).toContain('5 tools');
    expect(result).toContain('Write a function to sort arrays');
    expect(result).toContain('sess-123');
  });

  it('handles missing configs gracefully', () => {
    const sessions: AcontextSession[] = [
      {
        id: 'sess-99999999',
        project_id: 'proj-1',
        user_id: null,
        configs: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    const result = formatSessionsList(sessions);
    expect(result).toContain('?'); // model fallback
    expect(result).toContain('No prompt');
  });

  it('truncates long prompts at 60 chars', () => {
    const longPrompt = 'A'.repeat(100);
    const sessions: AcontextSession[] = [
      {
        id: 'sess-11111111',
        project_id: 'proj-1',
        user_id: 'u1',
        configs: { prompt: longPrompt, model: 'test' },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    const result = formatSessionsList(sessions);
    // Should contain truncated prompt with "..."
    expect(result).toContain('...');
    // Should not contain the full 100-char prompt on one line
    const promptLine = result.split('\n').find(l => l.includes('"A'));
    expect(promptLine!.length).toBeLessThan(120);
  });

  it('shows success/failure indicators', () => {
    const sessions: AcontextSession[] = [
      {
        id: 'sess-success',
        project_id: 'p',
        configs: { success: true, model: 'm', prompt: 'ok' },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        id: 'sess-failure',
        project_id: 'p',
        configs: { success: false, model: 'm', prompt: 'fail' },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    const result = formatSessionsList(sessions);
    // Success uses ✓, failure uses ✗
    expect(result).toContain('✓');
    expect(result).toContain('✗');
  });
});
