import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcontextClient } from './client';
import { AVAILABLE_TOOLS, executeTool, TOOLS_WITHOUT_BROWSER } from '../openrouter/tools';

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

// --- AcontextClient.executeCode ---

describe('AcontextClient.executeCode', () => {
  it('calls sandbox execute endpoint with expected payload', async () => {
    const client = new AcontextClient('test-key', 'https://api.test.com');
    const response = { stdout: 'ok', stderr: '', exitCode: 0, executionTimeMs: 12 };
    mockFetch.mockResolvedValueOnce(jsonResponse(response));

    const result = await client.executeCode({
      sessionId: 'session-1',
      language: 'python',
      code: 'print(1)',
      timeout: 42,
    });

    expect(result).toEqual(response);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.test.com/api/v1/sandbox/execute');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({
      session_id: 'session-1',
      language: 'python',
      code: 'print(1)',
      timeout: 42,
    });
  });

  it('uses default timeout of 30 seconds', async () => {
    const client = new AcontextClient('test-key', 'https://api.test.com');
    mockFetch.mockResolvedValueOnce(jsonResponse({ stdout: '', stderr: '', exitCode: 0, executionTimeMs: 5 }));

    await client.executeCode({ sessionId: 'session-1', language: 'bash', code: 'echo hi' });

    const [, options] = mockFetch.mock.calls[0];
    expect(JSON.parse(options.body).timeout).toBe(30);
  });

  it('clamps timeout to minimum 5 seconds', async () => {
    const client = new AcontextClient('test-key', 'https://api.test.com');
    mockFetch.mockResolvedValueOnce(jsonResponse({ stdout: '', stderr: '', exitCode: 0, executionTimeMs: 5 }));

    await client.executeCode({ sessionId: 'session-1', language: 'bash', code: 'echo hi', timeout: 1 });

    const [, options] = mockFetch.mock.calls[0];
    expect(JSON.parse(options.body).timeout).toBe(5);
  });

  it('clamps timeout to maximum 120 seconds', async () => {
    const client = new AcontextClient('test-key', 'https://api.test.com');
    mockFetch.mockResolvedValueOnce(jsonResponse({ stdout: '', stderr: '', exitCode: 0, executionTimeMs: 5 }));

    await client.executeCode({ sessionId: 'session-1', language: 'bash', code: 'echo hi', timeout: 999 });

    const [, options] = mockFetch.mock.calls[0];
    expect(JSON.parse(options.body).timeout).toBe(120);
  });

  it('throws on non-ok API response', async () => {
    const client = new AcontextClient('test-key', 'https://api.test.com');
    mockFetch.mockResolvedValueOnce(new Response('boom', { status: 500 }));

    await expect(client.executeCode({ sessionId: 's1', language: 'python', code: 'print(1)' }))
      .rejects.toThrow('Acontext API POST /api/v1/sandbox/execute failed: 500 boom');
  });
});

// --- run_code tool ---

describe('run_code tool', () => {
  it('is present in tool definitions', () => {
    const tool = AVAILABLE_TOOLS.find(t => t.function.name === 'run_code');
    expect(tool).toBeDefined();
    expect(tool?.function.parameters.required).toEqual(['language', 'code']);
  });

  it('is available in TOOLS_WITHOUT_BROWSER', () => {
    const tool = TOOLS_WITHOUT_BROWSER.find(t => t.function.name === 'run_code');
    expect(tool).toBeDefined();
  });

  it('returns graceful error when acontext client is missing', async () => {
    const result = await executeTool({
      id: '1',
      type: 'function',
      function: {
        name: 'run_code',
        arguments: JSON.stringify({ language: 'python', code: 'print(1)' }),
      },
    });

    expect(result.content).toBe('Error: Code execution not available (Acontext not configured)');
  });

  it('executes code and returns stdout', async () => {
    const executeCode = vi.fn().mockResolvedValue({ stdout: 'hello', stderr: '', exitCode: 0, executionTimeMs: 14 });

    const result = await executeTool({
      id: '2',
      type: 'function',
      function: {
        name: 'run_code',
        arguments: JSON.stringify({ language: 'python', code: 'print("hello")' }),
      },
    }, {
      acontextClient: { executeCode } as unknown as AcontextClient,
      acontextSessionId: 'task-123',
    });

    expect(result.content).toBe('hello');
    expect(executeCode).toHaveBeenCalledWith({
      sessionId: 'task-123',
      language: 'python',
      code: 'print("hello")',
      timeout: 30,
    });
  });

  it('uses default session id when not provided', async () => {
    const executeCode = vi.fn().mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0, executionTimeMs: 1 });

    await executeTool({
      id: '3',
      type: 'function',
      function: {
        name: 'run_code',
        arguments: JSON.stringify({ language: 'bash', code: 'echo ok' }),
      },
    }, {
      acontextClient: { executeCode } as unknown as AcontextClient,
    });

    expect(executeCode).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'default' }));
  });

  it('formats stderr when stdout also exists', async () => {
    const executeCode = vi.fn().mockResolvedValue({
      stdout: 'out',
      stderr: 'warn',
      exitCode: 0,
      executionTimeMs: 1,
    });

    const result = await executeTool({
      id: '4',
      type: 'function',
      function: {
        name: 'run_code',
        arguments: JSON.stringify({ language: 'bash', code: 'echo out >&2' }),
      },
    }, { acontextClient: { executeCode } as unknown as AcontextClient });

    expect(result.content).toBe('out\n\nSTDERR:\nwarn');
  });

  it('formats stderr-only output', async () => {
    const executeCode = vi.fn().mockResolvedValue({
      stdout: '',
      stderr: 'only error',
      exitCode: 1,
      executionTimeMs: 1,
    });

    const result = await executeTool({
      id: '5',
      type: 'function',
      function: {
        name: 'run_code',
        arguments: JSON.stringify({ language: 'bash', code: 'exit 1' }),
      },
    }, { acontextClient: { executeCode } as unknown as AcontextClient });

    expect(result.content).toBe('STDERR:\nonly error');
  });

  it('shows exit code when no output', async () => {
    const executeCode = vi.fn().mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 2,
      executionTimeMs: 1,
    });

    const result = await executeTool({
      id: '6',
      type: 'function',
      function: {
        name: 'run_code',
        arguments: JSON.stringify({ language: 'javascript', code: 'process.exit(2)' }),
      },
    }, { acontextClient: { executeCode } as unknown as AcontextClient });

    expect(result.content).toBe('(no output, exit code: 2)');
  });

  it('clamps timeout from args to max 120', async () => {
    const executeCode = vi.fn().mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0, executionTimeMs: 1 });

    await executeTool({
      id: '7',
      type: 'function',
      function: {
        name: 'run_code',
        arguments: JSON.stringify({ language: 'python', code: 'print(1)', timeout: 999 }),
      },
    }, { acontextClient: { executeCode } as unknown as AcontextClient });

    expect(executeCode).toHaveBeenCalledWith(expect.objectContaining({ timeout: 120 }));
  });

  it('clamps timeout from args to min 5', async () => {
    const executeCode = vi.fn().mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0, executionTimeMs: 1 });

    await executeTool({
      id: '8',
      type: 'function',
      function: {
        name: 'run_code',
        arguments: JSON.stringify({ language: 'python', code: 'print(1)', timeout: 1 }),
      },
    }, { acontextClient: { executeCode } as unknown as AcontextClient });

    expect(executeCode).toHaveBeenCalledWith(expect.objectContaining({ timeout: 5 }));
  });

  it('supports string timeout values', async () => {
    const executeCode = vi.fn().mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0, executionTimeMs: 1 });

    await executeTool({
      id: '9',
      type: 'function',
      function: {
        name: 'run_code',
        arguments: JSON.stringify({ language: 'python', code: 'print(1)', timeout: '45' }),
      },
    }, { acontextClient: { executeCode } as unknown as AcontextClient });

    expect(executeCode).toHaveBeenCalledWith(expect.objectContaining({ timeout: 45 }));
  });

  it('rejects invalid language', async () => {
    const executeCode = vi.fn();

    const result = await executeTool({
      id: '10',
      type: 'function',
      function: {
        name: 'run_code',
        arguments: JSON.stringify({ language: 'ruby', code: 'puts 1' }),
      },
    }, { acontextClient: { executeCode } as unknown as AcontextClient });

    expect(result.content).toContain('Error executing run_code: Invalid language: ruby');
    expect(executeCode).not.toHaveBeenCalled();
  });

  it('rejects empty code', async () => {
    const result = await executeTool({
      id: '11',
      type: 'function',
      function: {
        name: 'run_code',
        arguments: JSON.stringify({ language: 'python', code: '  ' }),
      },
    }, { acontextClient: { executeCode: vi.fn() } as unknown as AcontextClient });

    expect(result.content).toContain('Error executing run_code: Code must be a non-empty string.');
  });

  it('rejects overly long code', async () => {
    const result = await executeTool({
      id: '12',
      type: 'function',
      function: {
        name: 'run_code',
        arguments: JSON.stringify({ language: 'bash', code: 'a'.repeat(100001) }),
      },
    }, { acontextClient: { executeCode: vi.fn() } as unknown as AcontextClient });

    expect(result.content).toContain('Error executing run_code: Code too long (100001 chars). Maximum is 100000.');
  });

  it('truncates output to 50KB', async () => {
    const executeCode = vi.fn().mockResolvedValue({
      stdout: 'x'.repeat(50050),
      stderr: '',
      exitCode: 0,
      executionTimeMs: 5,
    });

    const result = await executeTool({
      id: '13',
      type: 'function',
      function: {
        name: 'run_code',
        arguments: JSON.stringify({ language: 'python', code: 'print("x")' }),
      },
    }, { acontextClient: { executeCode } as unknown as AcontextClient });

    expect(result.content.length).toBeLessThanOrEqual(50000 + '\n... (truncated)'.length);
    expect(result.content.endsWith('\n... (truncated)')).toBe(true);
  });

  it('returns tool execution error for network failures', async () => {
    const executeCode = vi.fn().mockRejectedValue(new Error('network down'));

    const result = await executeTool({
      id: '14',
      type: 'function',
      function: {
        name: 'run_code',
        arguments: JSON.stringify({ language: 'python', code: 'print(1)' }),
      },
    }, { acontextClient: { executeCode } as unknown as AcontextClient });

    expect(result.content).toBe('Error executing run_code: network down');
  });
});
