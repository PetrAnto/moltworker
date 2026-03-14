import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
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

describe('AcontextClient sandbox execution', () => {
  it('calls sandbox execute endpoint with mapped payload', async () => {
    const client = new AcontextClient('key', 'https://api.test.com');
    mockFetch.mockResolvedValueOnce(jsonResponse({
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
      executionTimeMs: 12,
    }));

    const result = await client.executeCode({
      sessionId: 'sess-1',
      language: 'python',
      code: 'print(1)',
      timeout: 25,
    });

    expect(result.stdout).toBe('ok');
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.test.com/api/v1/sandbox/execute');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body).toEqual({
      session_id: 'sess-1',
      language: 'python',
      code: 'print(1)',
      timeout: 25,
    });
  });

  it('defaults timeout to 30 seconds', async () => {
    const client = new AcontextClient('key', 'https://api.test.com');
    mockFetch.mockResolvedValueOnce(jsonResponse({
      stdout: '',
      stderr: '',
      exitCode: 0,
      executionTimeMs: 10,
    }));

    await client.executeCode({
      sessionId: 'sess-2',
      language: 'bash',
      code: 'echo hi',
    });

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.timeout).toBe(30);
  });

  it('clamps timeout below minimum to 5', async () => {
    const client = new AcontextClient('key', 'https://api.test.com');
    mockFetch.mockResolvedValueOnce(jsonResponse({
      stdout: '',
      stderr: '',
      exitCode: 0,
      executionTimeMs: 1,
    }));

    await client.executeCode({
      sessionId: 'sess-3',
      language: 'javascript',
      code: 'console.log(1)',
      timeout: 1,
    });

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.timeout).toBe(5);
  });

  it('clamps timeout above maximum to 120', async () => {
    const client = new AcontextClient('key', 'https://api.test.com');
    mockFetch.mockResolvedValueOnce(jsonResponse({
      stdout: '',
      stderr: '',
      exitCode: 124,
      executionTimeMs: 120000,
    }));

    await client.executeCode({
      sessionId: 'sess-4',
      language: 'python',
      code: 'while True: pass',
      timeout: 999,
    });

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.timeout).toBe(120);
  });

  it('propagates HTTP errors from sandbox API', async () => {
    const client = new AcontextClient('key', 'https://api.test.com');
    mockFetch.mockResolvedValueOnce(new Response('Bad Request', { status: 400 }));

    await expect(
      client.executeCode({
        sessionId: 'sess-5',
        language: 'bash',
        code: 'echo bad',
      })
    ).rejects.toThrow('Acontext API POST /api/v1/sandbox/execute failed: 400 Bad Request');
  });
});
