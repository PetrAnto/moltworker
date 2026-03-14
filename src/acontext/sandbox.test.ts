import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcontextClient } from './client';

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

describe('AcontextClient.executeCode', () => {
  it('calls sandbox execute endpoint with payload', async () => {
    const client = new AcontextClient('test-key', 'https://api.test.com');
    mockFetch.mockResolvedValueOnce(jsonResponse({
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
      executionTimeMs: 123,
    }));

    const result = await client.executeCode({
      sessionId: 'sess-1',
      language: 'python',
      code: 'print(1)',
      timeout: 45,
    });

    expect(result.stdout).toBe('ok');
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.test.com/api/v1/sandbox/execute');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Authorization']).toBe('Bearer test-key');
    const body = JSON.parse(opts.body);
    expect(body).toEqual({
      sessionId: 'sess-1',
      language: 'python',
      code: 'print(1)',
      timeout: 45,
    });
  });

  it('defaults timeout to 30 seconds', async () => {
    const client = new AcontextClient('test-key', 'https://api.test.com');
    mockFetch.mockResolvedValueOnce(jsonResponse({
      stdout: '',
      stderr: '',
      exitCode: 0,
      executionTimeMs: 5,
    }));

    await client.executeCode({ sessionId: 'sess-1', language: 'bash', code: 'echo hi' });

    const [, opts] = mockFetch.mock.calls[0];
    expect(JSON.parse(opts.body).timeout).toBe(30);
  });

  it('clamps timeout to minimum 5 seconds', async () => {
    const client = new AcontextClient('test-key', 'https://api.test.com');
    mockFetch.mockResolvedValueOnce(jsonResponse({
      stdout: '',
      stderr: '',
      exitCode: 0,
      executionTimeMs: 5,
    }));

    await client.executeCode({ sessionId: 'sess-1', language: 'javascript', code: 'console.log(1)', timeout: 1 });

    const [, opts] = mockFetch.mock.calls[0];
    expect(JSON.parse(opts.body).timeout).toBe(5);
  });

  it('clamps timeout to maximum 120 seconds', async () => {
    const client = new AcontextClient('test-key', 'https://api.test.com');
    mockFetch.mockResolvedValueOnce(jsonResponse({
      stdout: '',
      stderr: '',
      exitCode: 0,
      executionTimeMs: 5,
    }));

    await client.executeCode({ sessionId: 'sess-1', language: 'bash', code: 'echo hi', timeout: 999 });

    const [, opts] = mockFetch.mock.calls[0];
    expect(JSON.parse(opts.body).timeout).toBe(120);
  });

  it('surfaces API errors', async () => {
    const client = new AcontextClient('test-key', 'https://api.test.com');
    mockFetch.mockResolvedValueOnce(new Response('bad request', { status: 400 }));

    await expect(client.executeCode({ sessionId: 'sess-1', language: 'python', code: 'print(1)' }))
      .rejects.toThrow('Acontext API POST /api/v1/sandbox/execute failed: 400 bad request');
  });
});
