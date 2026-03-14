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

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('AcontextClient disk methods', () => {
  it('writeFile sends expected payload', async () => {
    const client = new AcontextClient('test-key', 'https://api.test.com');
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, bytesWritten: 12 }));

    const result = await client.writeFile({ sessionId: 's1', name: 'notes.txt', content: 'hello world!' });

    expect(result).toEqual({ success: true, bytesWritten: 12 });
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.test.com/api/v1/disk/files');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({
      session_id: 's1',
      name: 'notes.txt',
      content: 'hello world!',
    });
  });

  it('readFile returns content when found', async () => {
    const client = new AcontextClient('test-key', 'https://api.test.com');
    mockFetch.mockResolvedValueOnce(jsonResponse({ content: 'abc', size: 3 }));

    const result = await client.readFile({ sessionId: 'task-1', name: 'data/out.txt' });

    expect(result).toEqual({ content: 'abc', size: 3 });
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.test.com/api/v1/disk/files/task-1/data%2Fout.txt');
    expect(options.method).toBe('GET');
  });

  it('readFile returns null on 404', async () => {
    const client = new AcontextClient('test-key', 'https://api.test.com');
    mockFetch.mockResolvedValueOnce(new Response('missing', { status: 404 }));

    const result = await client.readFile({ sessionId: 'task-1', name: 'missing.txt' });

    expect(result).toBeNull();
  });

  it('listFiles supports optional prefix', async () => {
    const client = new AcontextClient('test-key', 'https://api.test.com');
    mockFetch.mockResolvedValueOnce(jsonResponse([{ name: 'data/a.txt', size: 2, updatedAt: '2026-01-01T00:00:00Z' }]));

    const result = await client.listFiles({ sessionId: 'task-1', prefix: 'data/' });

    expect(result).toHaveLength(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.test.com/api/v1/disk/files?session_id=task-1&prefix=data%2F');
    expect(options.method).toBe('GET');
  });

  it('deleteFile returns success=true for 204', async () => {
    const client = new AcontextClient('test-key', 'https://api.test.com');
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const result = await client.deleteFile({ sessionId: 'task-1', name: 'x.txt' });

    expect(result).toEqual({ success: true });
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.test.com/api/v1/disk/files/task-1/x.txt');
    expect(options.method).toBe('DELETE');
  });

  it('deleteFile returns success=false for 404', async () => {
    const client = new AcontextClient('test-key', 'https://api.test.com');
    mockFetch.mockResolvedValueOnce(new Response('missing', { status: 404 }));

    const result = await client.deleteFile({ sessionId: 'task-1', name: 'x.txt' });

    expect(result).toEqual({ success: false });
  });
});

describe('saved file tools definitions', () => {
  it('includes all saved file tools', () => {
    expect(AVAILABLE_TOOLS.some(t => t.function.name === 'save_file')).toBe(true);
    expect(AVAILABLE_TOOLS.some(t => t.function.name === 'read_saved_file')).toBe(true);
    expect(AVAILABLE_TOOLS.some(t => t.function.name === 'list_saved_files')).toBe(true);
    expect(AVAILABLE_TOOLS.some(t => t.function.name === 'delete_saved_file')).toBe(true);
  });
});

describe('save_file tool', () => {
  it('returns error when acontext client is missing', async () => {
    const result = await executeTool({
      id: '1',
      type: 'function',
      function: { name: 'save_file', arguments: JSON.stringify({ name: 'a.txt', content: 'a' }) },
    });

    expect(result.content).toBe('Error: File storage not available (Acontext not configured)');
  });

  it('saves file successfully', async () => {
    const listFiles = vi.fn().mockResolvedValue([]);
    const writeFile = vi.fn().mockResolvedValue({ success: true, bytesWritten: 5 });

    const result = await executeTool({
      id: '2',
      type: 'function',
      function: { name: 'save_file', arguments: JSON.stringify({ name: 'notes.txt', content: 'hello' }) },
    }, {
      acontextClient: { listFiles, writeFile } as unknown as AcontextClient,
      acontextSessionId: 'sess-9',
    });

    expect(writeFile).toHaveBeenCalledWith({ sessionId: 'sess-9', name: 'notes.txt', content: 'hello' });
    expect(result.content).toBe('File saved: notes.txt (5 bytes)');
  });

  it('enforces file size limit', async () => {
    const result = await executeTool({
      id: '3',
      type: 'function',
      function: { name: 'save_file', arguments: JSON.stringify({ name: 'big.txt', content: 'a'.repeat(1_000_001) }) },
    }, {
      acontextClient: { listFiles: vi.fn().mockResolvedValue([]), writeFile: vi.fn() } as unknown as AcontextClient,
    });

    expect(result.content).toContain('Error: File too large');
  });

  it('blocks invalid file names', async () => {
    const result = await executeTool({
      id: '4',
      type: 'function',
      function: { name: 'save_file', arguments: JSON.stringify({ name: '../secret.txt', content: 'x' }) },
    }, {
      acontextClient: { listFiles: vi.fn().mockResolvedValue([]), writeFile: vi.fn() } as unknown as AcontextClient,
    });

    expect(result.content).toContain('Path traversal');
  });

  it('enforces max files per session', async () => {
    const files = Array.from({ length: 100 }, (_, i) => ({ name: `f-${i}.txt`, size: 1, updatedAt: '2026-01-01T00:00:00Z' }));
    const writeFile = vi.fn();

    const result = await executeTool({
      id: '5',
      type: 'function',
      function: { name: 'save_file', arguments: JSON.stringify({ name: 'new.txt', content: 'x' }) },
    }, {
      acontextClient: { listFiles: vi.fn().mockResolvedValue(files), writeFile } as unknown as AcontextClient,
    });

    expect(result.content).toContain('File limit reached');
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('rejects binary-like content', async () => {
    const result = await executeTool({
      id: '6',
      type: 'function',
      function: { name: 'save_file', arguments: JSON.stringify({ name: 'a.txt', content: 'ok\u0000bad' }) },
    }, {
      acontextClient: { listFiles: vi.fn().mockResolvedValue([]), writeFile: vi.fn() } as unknown as AcontextClient,
    });

    expect(result.content).toContain('Binary content is not supported');
  });
});

describe('read_saved_file tool', () => {
  it('reads file content', async () => {
    const readFile = vi.fn().mockResolvedValue({ content: 'cached data', size: 11 });

    const result = await executeTool({
      id: '7',
      type: 'function',
      function: { name: 'read_saved_file', arguments: JSON.stringify({ name: 'cache/result.txt' }) },
    }, {
      acontextClient: { readFile } as unknown as AcontextClient,
      acontextSessionId: 'task-3',
    });

    expect(readFile).toHaveBeenCalledWith({ sessionId: 'task-3', name: 'cache/result.txt' });
    expect(result.content).toBe('cached data');
  });

  it('returns file not found', async () => {
    const result = await executeTool({
      id: '8',
      type: 'function',
      function: { name: 'read_saved_file', arguments: JSON.stringify({ name: 'missing.txt' }) },
    }, {
      acontextClient: { readFile: vi.fn().mockResolvedValue(null) } as unknown as AcontextClient,
    });

    expect(result.content).toBe('File not found: missing.txt');
  });

  it('returns error when client is missing', async () => {
    const result = await executeTool({
      id: '9',
      type: 'function',
      function: { name: 'read_saved_file', arguments: JSON.stringify({ name: 'x.txt' }) },
    });

    expect(result.content).toBe('Error: File storage not available (Acontext not configured)');
  });
});

describe('list_saved_files tool', () => {
  it('lists files with prefix', async () => {
    const listFiles = vi.fn().mockResolvedValue([{ name: 'data/a.json', size: 10, updatedAt: '2026-01-01T01:00:00Z' }]);

    const result = await executeTool({
      id: '10',
      type: 'function',
      function: { name: 'list_saved_files', arguments: JSON.stringify({ prefix: 'data/' }) },
    }, {
      acontextClient: { listFiles } as unknown as AcontextClient,
      acontextSessionId: 'task-4',
    });

    expect(listFiles).toHaveBeenCalledWith({ sessionId: 'task-4', prefix: 'data/' });
    expect(result.content).toContain('data/a.json (10 bytes');
  });

  it('lists files without prefix', async () => {
    const listFiles = vi.fn().mockResolvedValue([{ name: 'a.txt', size: 1, updatedAt: '2026-01-01T01:00:00Z' }]);

    await executeTool({
      id: '11',
      type: 'function',
      function: { name: 'list_saved_files', arguments: '{}' },
    }, {
      acontextClient: { listFiles } as unknown as AcontextClient,
    });

    expect(listFiles).toHaveBeenCalledWith({ sessionId: 'default', prefix: undefined });
  });

  it('returns empty message', async () => {
    const result = await executeTool({
      id: '12',
      type: 'function',
      function: { name: 'list_saved_files', arguments: '{}' },
    }, {
      acontextClient: { listFiles: vi.fn().mockResolvedValue([]) } as unknown as AcontextClient,
    });

    expect(result.content).toBe('No saved files found.');
  });
});

describe('delete_saved_file tool', () => {
  it('deletes file successfully', async () => {
    const deleteFile = vi.fn().mockResolvedValue({ success: true });

    const result = await executeTool({
      id: '13',
      type: 'function',
      function: { name: 'delete_saved_file', arguments: JSON.stringify({ name: 'old.txt' }) },
    }, {
      acontextClient: { deleteFile } as unknown as AcontextClient,
      acontextSessionId: 'task-5',
    });

    expect(deleteFile).toHaveBeenCalledWith({ sessionId: 'task-5', name: 'old.txt' });
    expect(result.content).toBe('File deleted: old.txt');
  });

  it('returns not found for missing file', async () => {
    const result = await executeTool({
      id: '14',
      type: 'function',
      function: { name: 'delete_saved_file', arguments: JSON.stringify({ name: 'missing.txt' }) },
    }, {
      acontextClient: { deleteFile: vi.fn().mockResolvedValue({ success: false }) } as unknown as AcontextClient,
    });

    expect(result.content).toBe('File not found: missing.txt');
  });
});

describe('saved files security', () => {
  it('blocks absolute paths', async () => {
    const result = await executeTool({
      id: '15',
      type: 'function',
      function: { name: 'read_saved_file', arguments: JSON.stringify({ name: '/etc/passwd' }) },
    }, {
      acontextClient: { readFile: vi.fn() } as unknown as AcontextClient,
    });

    expect(result.content).toContain('relative paths only');
  });

  it('blocks null bytes in name', async () => {
    const result = await executeTool({
      id: '16',
      type: 'function',
      function: { name: 'delete_saved_file', arguments: JSON.stringify({ name: 'bad\u0000name.txt' }) },
    }, {
      acontextClient: { deleteFile: vi.fn() } as unknown as AcontextClient,
    });

    expect(result.content).toContain('Null bytes are not allowed');
  });
});
