import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcontextClient } from './client';
import { AVAILABLE_TOOLS, executeTool } from '../openrouter/tools';

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function wrappedJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('AcontextClient.executeCode', () => {
  const client = new AcontextClient('key', 'https://api.test.com');

  it('calls sandbox execute endpoint with payload', async () => {
    mockFetch.mockResolvedValueOnce(wrappedJson({ stdout: 'ok', stderr: '', exitCode: 0, executionTimeMs: 12 }));
    const result = await client.executeCode({ sessionId: 's1', language: 'python', code: 'print(1)' });
    expect(result.stdout).toBe('ok');
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.test.com/api/v1/sandbox/execute');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({
      session_id: 's1',
      language: 'python',
      code: 'print(1)',
      timeout: 30,
    });
  });

  it('passes javascript language', async () => {
    mockFetch.mockResolvedValueOnce(wrappedJson({ stdout: 'js', stderr: '', exitCode: 0, executionTimeMs: 8 }));
    await client.executeCode({ sessionId: 's2', language: 'javascript', code: 'console.log(1)' });
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).language).toBe('javascript');
  });

  it('passes bash language', async () => {
    mockFetch.mockResolvedValueOnce(wrappedJson({ stdout: 'bash', stderr: '', exitCode: 0, executionTimeMs: 8 }));
    await client.executeCode({ sessionId: 's3', language: 'bash', code: 'echo hi' });
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).language).toBe('bash');
  });

  it('clamps timeout to min 5', async () => {
    mockFetch.mockResolvedValueOnce(wrappedJson({ stdout: '', stderr: '', exitCode: 0, executionTimeMs: 1 }));
    await client.executeCode({ sessionId: 's4', language: 'python', code: '1', timeout: 1 });
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).timeout).toBe(5);
  });

  it('clamps timeout to max 120', async () => {
    mockFetch.mockResolvedValueOnce(wrappedJson({ stdout: '', stderr: '', exitCode: 0, executionTimeMs: 1 }));
    await client.executeCode({ sessionId: 's5', language: 'python', code: '1', timeout: 999 });
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).timeout).toBe(120);
  });

  it('throws on API errors', async () => {
    mockFetch.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    await expect(client.executeCode({ sessionId: 's6', language: 'python', code: '1' })).rejects.toThrow('500');
  });

  it('unwraps direct json responses', async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ stdout: 'raw', stderr: '', exitCode: 0, executionTimeMs: 10 }), { status: 200 }));
    const result = await client.executeCode({ sessionId: 's7', language: 'python', code: '1' });
    expect(result.stdout).toBe('raw');
  });

  it('uses default timeout when missing', async () => {
    mockFetch.mockResolvedValueOnce(wrappedJson({ stdout: '', stderr: '', exitCode: 0, executionTimeMs: 1 }));
    await client.executeCode({ sessionId: 's8', language: 'python', code: '1' });
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).timeout).toBe(30);
  });

  it('keeps normal timeout as-is', async () => {
    mockFetch.mockResolvedValueOnce(wrappedJson({ stdout: '', stderr: '', exitCode: 0, executionTimeMs: 1 }));
    await client.executeCode({ sessionId: 's9', language: 'python', code: '1', timeout: 42 });
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).timeout).toBe(42);
  });

  it('includes session id in payload', async () => {
    mockFetch.mockResolvedValueOnce(wrappedJson({ stdout: '', stderr: '', exitCode: 0, executionTimeMs: 1 }));
    await client.executeCode({ sessionId: 'abc-123', language: 'python', code: '1' });
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).session_id).toBe('abc-123');
  });
});

describe('run_code tool', () => {
  it('is included in AVAILABLE_TOOLS with enum', () => {
    const tool = AVAILABLE_TOOLS.find(t => t.function.name === 'run_code');
    expect(tool).toBeDefined();
    expect(tool?.function.parameters.required).toEqual(['language', 'code']);
    expect(tool?.function.parameters.properties.language.enum).toEqual(['python', 'javascript', 'bash']);
  });

  it('fails when acontext client missing', async () => {
    const result = await executeTool({ id: 'r1', type: 'function', function: { name: 'run_code', arguments: JSON.stringify({ language: 'python', code: 'print(1)' }) } });
    expect(result.content).toContain('Acontext not configured');
  });

  it('dispatches to acontext executeCode', async () => {
    const executeCode = vi.fn().mockResolvedValue({ stdout: '42', stderr: '', exitCode: 0, executionTimeMs: 5 });
    const result = await executeTool({ id: 'r2', type: 'function', function: { name: 'run_code', arguments: JSON.stringify({ language: 'python', code: 'print(42)', timeout: 15 }) } }, {
      acontextClient: { executeCode } as unknown as AcontextClient,
      acontextSessionId: 'task-1',
    });

    expect(result.content).toBe('42');
    expect(executeCode).toHaveBeenCalledWith({
      sessionId: 'task-1',
      language: 'python',
      code: 'print(42)',
      timeout: 15,
    });
  });

  it('uses default session id fallback', async () => {
    const executeCode = vi.fn().mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0, executionTimeMs: 5 });
    await executeTool({ id: 'r3', type: 'function', function: { name: 'run_code', arguments: JSON.stringify({ language: 'bash', code: 'echo ok' }) } }, {
      acontextClient: { executeCode } as unknown as AcontextClient,
    });
    expect(executeCode).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'default' }));
  });

  it('clamps timeout in tool path', async () => {
    const executeCode = vi.fn().mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0, executionTimeMs: 5 });
    await executeTool({ id: 'r4', type: 'function', function: { name: 'run_code', arguments: JSON.stringify({ language: 'bash', code: 'echo ok', timeout: 500 }) } }, {
      acontextClient: { executeCode } as unknown as AcontextClient,
    });
    expect(executeCode).toHaveBeenCalledWith(expect.objectContaining({ timeout: 120 }));
  });

  it('formats stderr-only output', async () => {
    const executeCode = vi.fn().mockResolvedValue({ stdout: '', stderr: 'warn', exitCode: 1, executionTimeMs: 5 });
    const result = await executeTool({ id: 'r5', type: 'function', function: { name: 'run_code', arguments: JSON.stringify({ language: 'bash', code: 'echo err >&2' }) } }, {
      acontextClient: { executeCode } as unknown as AcontextClient,
    });
    expect(result.content).toBe('STDERR:\nwarn');
  });

  it('formats stdout+stderr output', async () => {
    const executeCode = vi.fn().mockResolvedValue({ stdout: 'out', stderr: 'err', exitCode: 1, executionTimeMs: 5 });
    const result = await executeTool({ id: 'r6', type: 'function', function: { name: 'run_code', arguments: JSON.stringify({ language: 'bash', code: 'x' }) } }, {
      acontextClient: { executeCode } as unknown as AcontextClient,
    });
    expect(result.content).toBe('out\n\nSTDERR:\nerr');
  });

  it('returns exit-code message when no output', async () => {
    const executeCode = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 7, executionTimeMs: 5 });
    const result = await executeTool({ id: 'r7', type: 'function', function: { name: 'run_code', arguments: JSON.stringify({ language: 'python', code: 'pass' }) } }, {
      acontextClient: { executeCode } as unknown as AcontextClient,
    });
    expect(result.content).toBe('(no output, exit code: 7)');
  });

  it('truncates output above 50KB', async () => {
    const executeCode = vi.fn().mockResolvedValue({ stdout: 'a'.repeat(50020), stderr: '', exitCode: 0, executionTimeMs: 5 });
    const result = await executeTool({ id: 'r8', type: 'function', function: { name: 'run_code', arguments: JSON.stringify({ language: 'python', code: 'pass' }) } }, {
      acontextClient: { executeCode } as unknown as AcontextClient,
    });
    expect(result.content.endsWith('\n... (truncated)')).toBe(true);
  });

  it('validates language', async () => {
    const executeCode = vi.fn();
    const result = await executeTool({ id: 'r9', type: 'function', function: { name: 'run_code', arguments: JSON.stringify({ language: 'ruby', code: 'puts 1' }) } }, {
      acontextClient: { executeCode } as unknown as AcontextClient,
    });
    expect(result.content).toContain('language must be one of');
    expect(executeCode).not.toHaveBeenCalled();
  });

  it('validates non-empty code', async () => {
    const executeCode = vi.fn();
    const result = await executeTool({ id: 'r10', type: 'function', function: { name: 'run_code', arguments: JSON.stringify({ language: 'python', code: '   ' }) } }, {
      acontextClient: { executeCode } as unknown as AcontextClient,
    });
    expect(result.content).toContain('non-empty');
    expect(executeCode).not.toHaveBeenCalled();
  });

  it('surfaces executeCode errors via executeTool wrapper', async () => {
    const executeCode = vi.fn().mockRejectedValue(new Error('sandbox down'));
    const result = await executeTool({ id: 'r11', type: 'function', function: { name: 'run_code', arguments: JSON.stringify({ language: 'python', code: 'print(1)' }) } }, {
      acontextClient: { executeCode } as unknown as AcontextClient,
    });
    expect(result.content).toContain('Error executing run_code: sandbox down');
  });
});
